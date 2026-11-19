//! `swb-hold <run dir> <timeout seconds, 0 for none> <input: 0|1|pty> <command>`: holds one run independently of the
//! engine, which may stop and start again meanwhile. Starts the command in its own process group, copies its stdout
//! to `out` and stderr to `err` (each capped), kills its group on timeout, stops it on SIGTERM (SIGTERM to the group,
//! SIGKILL after a grace period), and records how it ended in `exit`, written last. With input, the command's stdin
//! is the FIFO `in`, which never reaches end of file, after the args line; otherwise it is this process's stdin.
//! With `pty`, the command runs in its own session on a pseudo-terminal instead, served on a Unix socket whose path is
//! written to `pty` (see `serve_pty`). The run folder stays locked while this process lives, so the engine can wait
//! on it after a restart.
//!
//! Only the standard library and libc, so it starts fast and stays small: one runs for every command run.

use std::collections::VecDeque;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long to wait for output after the command exits, in case something it started keeps the pipes open.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const OUT_CAP: u64 = 16 << 20;
const ERR_CAP: u64 = 1 << 20;
/// Output kept for a terminal client that connects later, so it starts from the current screen.
const REPLAY_CAP: usize = 256 << 10;
/// How long a terminal may go without a client before it is hung up.
const PTY_IDLE: Duration = Duration::from_secs(30);

static REASON: Mutex<Option<String>> = Mutex::new(None);

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let [dir, timeout, input, command] = args.as_slice() else {
        eprintln!("usage: swb-hold <run dir> <timeout seconds> <input 0|1|pty> <command>");
        return ExitCode::from(2);
    };
    let dir = PathBuf::from(dir);
    let timeout = timeout.to_str().and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
    let input = match input.to_str() {
        Some("1") => Input::Lines,
        Some("pty") => Input::Pty,
        _ => Input::Inherit,
    };
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

#[derive(PartialEq)]
enum Input {
    Inherit,
    Lines,
    Pty,
}

fn hold(dir: &Path, timeout: u64, input: Input, command: &Path) -> io::Result<String> {
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
    let pty = if input == Input::Pty {
        let (master, slave) = open_pty()?;
        command.stdin(slave.try_clone()?).stdout(slave.try_clone()?).stderr(slave).env("TERM", "xterm-256color");
        Some((master, bind_pty(dir)?))
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        None
    };
    let fifo = if input == Input::Lines {
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
        if pty.is_none() {
            command.stdin(Stdio::inherit());
        }
        None
    };
    let in_pty = pty.is_some();
    // SAFETY: pthread_sigmask, setsid and ioctl are async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            let empty = empty_signals();
            libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
            // Its own session, with the terminal as its controlling one, so job control and hangups work.
            if in_pty && (libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0) {
                return Err(io::Error::last_os_error());
            }
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
    let socket = match pty {
        Some((master, (listener, socket))) => {
            serve_pty(master, listener, group);
            Some(socket)
        }
        None => None,
    };
    let (pumped, drained) = channel();
    let mut pumps = Vec::new();
    for (from, name, cap) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "out", OUT_CAP),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "err", ERR_CAP),
    ] {
        let (path, pumped) = (dir.join(name), pumped.clone());
        let Some(from) = from else { continue };
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
    if let Some(socket) = socket {
        let _ = fs::remove_file(socket);
    }
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

fn open_pty() -> io::Result<(File, File)> {
    let (mut master, mut slave) = (0, 0);
    let mut size = libc::winsize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: openpty writes the two descriptors; the name and termios may be null.
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) } != 0 {
        return Err(io::Error::last_os_error());
    }
    for fd in [master, slave] {
        // SAFETY: fd is open; the command gets the slave through dup2, which clears FD_CLOEXEC.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    // SAFETY: openpty returned two open descriptors that nothing else owns.
    Ok(unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) })
}

/// Binds the terminal's socket in the user's runtime or temporary folder, readable by this user only, since a socket
/// path in the run folder can exceed the platform's limit, and writes its path to `pty`.
fn bind_pty(dir: &Path) -> io::Result<(UnixListener, PathBuf)> {
    let base = ["XDG_RUNTIME_DIR", "TMPDIR"].iter().find_map(std::env::var_os).unwrap_or("/tmp".into());
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let socket = PathBuf::from(base).join(format!("swb-{name}.sock"));
    let _ = fs::remove_file(&socket);
    // SAFETY: umask has no preconditions; no other thread exists yet to create files meanwhile.
    let previous = unsafe { libc::umask(0o077) };
    let listener = UnixListener::bind(&socket);
    // SAFETY: as above.
    unsafe { libc::umask(previous) };
    let listener = listener?;
    fs::write(dir.join("pty"), socket.as_os_str().as_bytes())?;
    Ok((listener, socket))
}

/// Clients of a terminal, and the output to replay to the next one.
#[derive(Default)]
struct Screen {
    clients: Vec<(u64, Sender<Arc<[u8]>>)>,
    replay: VecDeque<u8>,
    next: u64,
    idle_since: Option<Instant>,
}

/// Serves the terminal on `listener`: every client gets the recent output, then everything the command writes, and
/// sends frames of a kind byte, a big-endian u32 length and the payload: 0 for input, 1 for a resize to a
/// big-endian u16 column and row count. Hangs the command up once it has had no client for `PTY_IDLE`.
fn serve_pty(master: File, listener: UnixListener, group: libc::pid_t) {
    let screen = Arc::new(Mutex::new(Screen { idle_since: Some(Instant::now()), ..Screen::default() }));
    let writer = Arc::new(Mutex::new(master.try_clone().expect("dup the terminal")));
    let output = screen.clone();
    thread::spawn(move || {
        let mut master = master;
        let mut buf = [0u8; 16 << 10];
        while let Ok(n @ 1..) = master.read(&mut buf) {
            let chunk: Arc<[u8]> = buf[..n].into();
            let mut screen = output.lock().unwrap();
            screen.replay.extend(chunk.iter());
            let excess = screen.replay.len().saturating_sub(REPLAY_CAP);
            screen.replay.drain(..excess);
            screen.clients.retain(|(_, client)| client.send(chunk.clone()).is_ok());
        }
    });
    let idle = screen.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(1));
            if idle.lock().unwrap().idle_since.is_some_and(|since| since.elapsed() > PTY_IDLE) {
                break;
            }
        }
        set_reason("stopped");
        kill_group(group, libc::SIGHUP);
        thread::sleep(STOP_GRACE);
        kill_group(group, libc::SIGKILL);
    });
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (sender, chunks) = channel::<Arc<[u8]>>();
            let id = {
                let mut screen = screen.lock().unwrap();
                let replay: Vec<u8> = screen.replay.iter().copied().collect();
                let _ = sender.send(replay.into());
                screen.next += 1;
                let id = screen.next;
                screen.clients.push((id, sender));
                screen.idle_since = None;
                id
            };
            let Ok(mut out) = stream.try_clone() else { continue };
            thread::spawn(move || {
                for chunk in chunks {
                    if out.write_all(&chunk).is_err() {
                        break;
                    }
                }
                let _ = out.shutdown(std::net::Shutdown::Both);
            });
            let (screen, writer) = (screen.clone(), writer.clone());
            thread::spawn(move || {
                read_frames(stream, &writer);
                let mut screen = screen.lock().unwrap();
                screen.clients.retain(|(client, _)| *client != id);
                if screen.clients.is_empty() {
                    screen.idle_since = Some(Instant::now());
                }
            });
        }
    });
}

fn read_frames(mut stream: UnixStream, master: &Mutex<File>) {
    let mut header = [0u8; 5];
    while stream.read_exact(&mut header).is_ok() {
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let mut payload = vec![0u8; len.min(1 << 20)];
        if len > payload.len() || stream.read_exact(&mut payload).is_err() {
            return;
        }
        match (header[0], payload.as_slice()) {
            (0, input) => _ = master.lock().unwrap().write_all(input),
            (1, &[c0, c1, r0, r1]) => {
                let size = libc::winsize {
                    ws_col: u16::from_be_bytes([c0, c1]),
                    ws_row: u16::from_be_bytes([r0, r1]),
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                // SAFETY: the descriptor is the open terminal and size outlives the call.
                unsafe { libc::ioctl(master.lock().unwrap().as_raw_fd(), libc::TIOCSWINSZ as _, &size) };
            }
            _ => {}
        }
    }
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
