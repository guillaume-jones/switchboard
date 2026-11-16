//! `swb-hold <run dir> <timeout seconds, 0 for none> <input: 0|1> <command>`: holds one run independently of the
//! engine, which may stop and start again meanwhile. Starts the command in its own process group, copies its stdout
//! to `out` and stderr to `err` (each capped), kills its group on timeout, stops it on SIGTERM (SIGTERM to the group,
//! SIGKILL after a grace period), and records how it ended in `exit`, written last. With input, the command's stdin
//! is the FIFO `in`, which never reaches end of file, after the args line; otherwise it is this process's stdin.
//! The run folder stays locked while this process lives, so the engine can wait on it after a restart.
//!
//! Only the standard library and libc, so it starts fast and stays small: one runs for every command run.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long to wait for output after the command exits, in case something it started keeps the pipes open.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const OUT_CAP: u64 = 16 << 20;
const ERR_CAP: u64 = 1 << 20;

static REASON: Mutex<Option<String>> = Mutex::new(None);

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let [dir, timeout, input, command] = args.as_slice() else {
        eprintln!("usage: swb-hold <run dir> <timeout seconds> <input 0|1> <command>");
        return ExitCode::from(2);
    };
    let dir = PathBuf::from(dir);
    let timeout = timeout.to_str().and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
    let input = input == "1";
    let exit = match hold(&dir, timeout, input, Path::new(command)) {
        Ok(exit) => exit,
        Err(e) => format!(r#"{{"code":null,"reason":"cannot start: {}"}}"#, escape(&e.to_string())),
    };
    let tmp = dir.join("exit.tmp");
    match fs::write(&tmp, exit).and_then(|()| fs::rename(&tmp, dir.join("exit"))) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

fn hold(dir: &Path, timeout: u64, input: bool, command: &Path) -> io::Result<String> {
    let lock = File::open(dir)?;
    // SAFETY: flock only reads the descriptor, which `lock` keeps open until this process exits.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    std::mem::forget(lock);
    let signals = stop_signals();
    // SAFETY: called before any thread exists; the command restores the mask in pre_exec.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut()) };

    let mut command = Command::new(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let fifo = if input {
        let path = dir.join("in");
        let c_path = CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: c_path is a valid NUL-terminated string.
        if unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // Opened for reading and writing, so the command's stdin never sees end of file while it runs.
        let fifo = OpenOptions::new().read(true).write(true).open(&path)?;
        command.stdin(fifo.try_clone()?);
        Some(fifo)
    } else {
        command.stdin(Stdio::inherit());
        None
    };
    // SAFETY: pthread_sigmask is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            let empty = empty_signals();
            libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
            Ok(())
        });
    }
    // A command file that was just written may still be open for writing, which exec refuses for a moment.
    let mut retries = 0;
    let mut child = loop {
        match command.spawn() {
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && retries < 10 => {
                retries += 1;
                thread::sleep(Duration::from_millis(20));
            }
            spawned => break spawned?,
        }
    };
    let group = child.id() as libc::pid_t;
    drop(command);
    if let Some(mut fifo) = fifo {
        thread::spawn(move || {
            let mut args = Vec::new();
            let _ = io::stdin().read_to_end(&mut args);
            if args.last() != Some(&b'\n') {
                args.push(b'\n');
            }
            let _ = fifo.write_all(&args);
        });
    }
    let (pumped, drained) = channel();
    let mut pumps = Vec::new();
    for (from, name, cap) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "out", OUT_CAP),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "err", ERR_CAP),
    ] {
        let (path, pumped) = (dir.join(name), pumped.clone());
        let from = from.expect("piped");
        pumps.push(path.clone());
        thread::spawn(move || {
            let truncated = pump(from, &path, cap);
            let _ = pumped.send((path, truncated));
        });
    }
    drop(pumped);
    thread::spawn(move || {
        let mut signal = 0;
        // SAFETY: the signals are blocked in every thread, so sigwait receives them.
        unsafe { libc::sigwait(&signals, &mut signal) };
        set_reason("stopped");
        kill_group(group, libc::SIGTERM);
        thread::sleep(STOP_GRACE);
        kill_group(group, libc::SIGKILL);
    });
    if timeout > 0 {
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(timeout));
            set_reason(&format!("timed out after {timeout}s"));
            kill_group(group, libc::SIGKILL);
        });
    }
    let status = child.wait()?;
    let reason = REASON.lock().unwrap().clone();
    if reason.is_some() {
        kill_group(group, libc::SIGKILL);
    }
    let mut truncated = Vec::new();
    for _ in 0..pumps.len() {
        match drained.recv_timeout(DRAIN_TIMEOUT) {
            Ok((path, true)) => truncated.push(path),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    for path in &pumps {
        if fs::metadata(path).is_ok_and(|m| m.len() == 0) {
            let _ = fs::remove_file(path);
        }
    }
    let code = status.code().map_or("null".into(), |c| c.to_string());
    let signal = status.signal().map_or("null".into(), |s| s.to_string());
    let reason = reason.map_or("null".into(), |r| format!("\"{}\"", escape(&r)));
    let truncated = truncated.iter().any(|p| p.ends_with("out"));
    Ok(format!(r#"{{"code":{code},"signal":{signal},"reason":{reason},"out_truncated":{truncated}}}"#))
}

/// Copies `from` into the file at `path` up to `cap` bytes, then a truncation note, and keeps draining the rest so
/// the command never blocks on a full pipe. Returns whether it truncated.
fn pump(mut from: impl Read, path: &Path, cap: u64) -> bool {
    let mut file = File::create(path).ok();
    let (mut written, mut truncated) = (0u64, false);
    let mut buf = [0u8; 16 << 10];
    while let Ok(n @ 1..) = from.read(&mut buf) {
        let room = cap.saturating_sub(written).min(n as u64) as usize;
        if let Some(file) = &mut file {
            let _ = file.write_all(&buf[..room]);
            if room < n && !truncated {
                let _ = writeln!(file, "\n[truncated at {} MB]", cap >> 20);
            }
        }
        truncated |= room < n;
        written += n as u64;
    }
    truncated
}

fn set_reason(reason: &str) {
    REASON.lock().unwrap().get_or_insert_with(|| reason.into());
}

fn kill_group(group: libc::pid_t, signal: libc::c_int) {
    // SAFETY: a negative pid addresses the command's process group.
    unsafe { libc::kill(-group, signal) };
}

fn empty_signals() -> libc::sigset_t {
    // SAFETY: sigemptyset initialises the set.
    unsafe {
        let mut set = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        set
    }
}

fn stop_signals() -> libc::sigset_t {
    let mut set = empty_signals();
    // SAFETY: set is initialised.
    unsafe { libc::sigaddset(&mut set, libc::SIGTERM) };
    set
}

fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '"' | '\\' => format!("\\{c}"),
            c if c.is_control() => " ".into(),
            c => c.to_string(),
        })
        .collect()
}
