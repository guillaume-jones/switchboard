//! Runs commands: each in its own process group with the login-shell environment, a timeout, output logged to
//! `data/logs/<run_id>.log`, and stdout captured for `into` or for the outcome line.

use crate::engine::{Child, Event, ExitReport, ExitState, Origin, Shared, display_text};
use anyhow::Result;
use serde_json::{Map, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const LOG_CAP: usize = 1 << 20;
/// Without `into`, only the end of stdout is kept, for the outcome line.
const TAIL: usize = 64 << 10;
const PAYLOAD_CAP: usize = 16 << 20;
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for output after the process exits, in case something it started keeps the pipes open.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) struct Job {
    pub id: String,
    pub path: PathBuf,
    pub args: Value,
    pub timeout: Duration,
    pub into: Option<PayloadWriter>,
}

/// The writer that receives a command's stdout as `:payload`.
pub(crate) struct PayloadWriter {
    pub writer: String,
    pub trigger: String,
}

/// The environment of a login shell, captured once, so commands see the user's `PATH` even when the app is
/// started from the Finder.
pub(crate) fn login_env(shared: &Shared) -> Vec<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut login = Command::new(&shell);
    login.args(["-lc", "env -0"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    let captured = login.spawn().map_err(|e| e.to_string()).and_then(|child| {
        let pid = child.id();
        let (done, output) = channel();
        thread::spawn(move || _ = done.send(child.wait_with_output()));
        match output.recv_timeout(LOGIN_SHELL_TIMEOUT) {
            Ok(Ok(o)) if o.status.success() => Ok(o.stdout),
            Ok(Ok(o)) => Err(format!("exited with {}", o.status)),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                crate::kill_process_group(pid);
                Err(format!("timed out after {}s", LOGIN_SHELL_TIMEOUT.as_secs()))
            }
        }
    });
    match captured {
        Ok(out) => String::from_utf8_lossy(&out)
            .split('\0')
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect(),
        Err(e) => {
            let message = format!("{shell} -lc env {e}; commands run with the app's environment");
            shared.record(Event::error("runner", "login shell", message));
            std::env::vars().collect()
        }
    }
}

/// Starts the command and supervises it on its own thread, which reports the exit to the writer thread.
pub(crate) fn spawn(shared: &Arc<Shared>, job: Job) -> Result<u32> {
    let home = &shared.home;
    let env = shared.login_env.get_or_init(|| login_env(shared));
    let mut path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()).unwrap_or_default();
    let swb = crate::swb_binary();
    if let Some(dir) = swb.as_deref().and_then(Path::parent) {
        path = format!("{}:{path}", dir.display());
    }
    let mut command = Command::new(&job.path);
    command
        .env_clear()
        .envs(env.iter().cloned())
        .env("PATH", path)
        .env("RUN_ID", &job.id)
        .env("SWITCHBOARD_HOME", home)
        .env("SOURCE_DIR", job.path.ancestors().nth(2).unwrap_or(home))
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(swb) = swb {
        command.env("SWB", swb);
    }
    for (name, value) in job.args.as_object().into_iter().flatten() {
        let name: String =
            name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
        command.env(format!("SWB_ARG_{name}"), display_text(value));
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
    let pid = child.id();
    shared.children.lock().unwrap().insert(job.id.clone(), Child::Process(pid));
    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let _ = fs::create_dir_all(home.join("data/logs"));
    let log = File::create(home.join(format!("data/logs/{}.log", job.id))).ok();
    let log = Arc::new(Mutex::new(RunLog { file: log, written: 0, truncated: false }));
    let shared = shared.clone();
    thread::spawn(move || {
        let report = ExitReport::new(&shared, job.id.clone());
        let args = job.args.to_string();
        // On its own thread: a command that never reads stdin must not keep its timeout from being enforced.
        thread::spawn(move || {
            let mut stdin = stdin;
            let _ = stdin.write_all(args.as_bytes());
        });
        let captured = Arc::new(Mutex::new(Captured::default()));
        let capture = if job.into.is_some() { Capture::Payload } else { Capture::Tail };
        let (pumped, drained) = channel();
        let (log_out, pumped_out, captured_out) = (log.clone(), pumped.clone(), captured.clone());
        thread::spawn(move || {
            pump(stdout, &log_out, Some((&captured_out, capture)));
            let _ = pumped_out.send(());
        });
        thread::spawn(move || {
            pump(stderr, &log, None);
            let _ = pumped.send(());
        });
        let (exited, status) = channel();
        thread::spawn(move || _ = exited.send(child.wait()));
        let status = match status.recv_timeout(job.timeout) {
            Ok(status) => status.ok(),
            Err(_) => {
                crate::kill_process_group(pid);
                let _ = status.recv();
                None
            }
        };
        // Its process group may be reused from now on, so the engine must not kill it.
        shared.children.lock().unwrap().insert(job.id.clone(), Child::InEngine);
        for _ in 0..2 {
            let _ = drained.recv_timeout(DRAIN_TIMEOUT);
        }
        let (stdout, overflowed) = {
            let captured = captured.lock().unwrap();
            (String::from_utf8_lossy(&captured.bytes).into_owned(), captured.overflowed)
        };
        let (mut state, mut summary) = match status {
            None => (ExitState::Failure, Some(format!("timed out after {}s", job.timeout.as_secs()))),
            Some(s) if s.success() => (ExitState::Success, None),
            Some(s) => (ExitState::Failure, Some(format!("exited with {s}"))),
        };
        match &job.into {
            None if status.is_some() => {
                let last_line = stdout.lines().rev().find(|l| !l.trim().is_empty());
                let outcome = last_line.and_then(|l| serde_json::from_str::<Value>(l).ok());
                if let Some(refined) = outcome.as_ref().and_then(|o| o["outcome"].as_str()).and_then(ExitState::parse) {
                    state = refined;
                }
                if let Some(s) = outcome.as_ref().and_then(|o| o["summary"].as_str()) {
                    summary = Some(s.to_string());
                }
            }
            None => {}
            Some(into) if overflowed => {
                state = ExitState::Failure;
                summary =
                    Some(format!("stdout exceeded the 16 MB payload limit; nothing was written to {}", into.writer));
            }
            Some(into) if state == ExitState::Success => {
                let origin = Origin { trigger: into.trigger.clone(), run_id: Some(job.id.clone()) };
                let payload = Value::Object(Map::from_iter([("payload".into(), Value::String(stdout))]));
                match shared.write(&into.writer, payload, origin) {
                    Ok(changes) => summary = Some(format!("{}: {changes} changes", into.writer)),
                    Err(e) => (state, summary) = (ExitState::Failure, Some(format!("{e:#}"))),
                }
            }
            Some(_) => {}
        }
        report.send(state, summary);
    });
    Ok(pid)
}

struct RunLog {
    file: Option<File>,
    written: usize,
    truncated: bool,
}

impl RunLog {
    fn append(&mut self, bytes: &[u8]) {
        let room = LOG_CAP.saturating_sub(self.written);
        if let Some(file) = &mut self.file {
            let _ = file.write_all(&bytes[..bytes.len().min(room)]);
            if bytes.len() > room && !self.truncated {
                let _ = file.write_all(b"\n[log truncated at 1 MB]\n");
            }
        }
        self.truncated |= bytes.len() > room;
        self.written += bytes.len();
    }
}

#[derive(Clone, Copy)]
enum Capture {
    /// Everything, up to `PAYLOAD_CAP`.
    Payload,
    /// The last `TAIL` to `2 * TAIL` bytes.
    Tail,
}

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn pump(mut from: impl Read, log: &Mutex<RunLog>, keep: Option<(&Mutex<Captured>, Capture)>) {
    let mut buf = [0u8; 8192];
    while let Ok(n @ 1..) = from.read(&mut buf) {
        let chunk = &buf[..n];
        if let Some((captured, capture)) = keep {
            let mut captured = captured.lock().unwrap();
            match capture {
                Capture::Payload if captured.bytes.len() + n > PAYLOAD_CAP => captured.overflowed = true,
                Capture::Payload => captured.bytes.extend_from_slice(chunk),
                Capture::Tail => {
                    captured.bytes.extend_from_slice(chunk);
                    if captured.bytes.len() > 2 * TAIL {
                        let cut = captured.bytes.len() - TAIL;
                        captured.bytes.drain(..cut);
                    }
                }
            }
        }
        log.lock().unwrap().append(chunk);
    }
}
