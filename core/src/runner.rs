//! Runs commands, each held by `swb-hold` in `data/runs/<run_id>/`: in its own process group with the login-shell
//! environment, a timeout, stdout in `out` and stderr in `err`. The holder outlives the engine, so a run started
//! before a restart is adopted by the next engine and finishes normally.

use crate::engine::{Child, Event, ExitReport, ExitState, Origin, Shared, display_text};
use crate::loader::{Action, Rule};
use anyhow::{Result, anyhow, bail};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

/// Without `into`, only the end of stdout is read, for the outcome line.
const TAIL: u64 = 64 << 10;
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Job {
    pub id: String,
    pub path: PathBuf,
    pub args: Value,
    /// `None` for a long-running command, which also keeps its stdin open for `swb run input`.
    pub timeout: Option<Duration>,
    pub into: Option<PayloadWriter>,
}

/// The writer that receives a command's stdout as `:payload`.
pub(crate) struct PayloadWriter {
    pub writer: String,
    pub trigger: String,
}

impl PayloadWriter {
    /// The rule's `into`, if it runs a command.
    pub(crate) fn of(rule: Option<&Rule>) -> Option<PayloadWriter> {
        rule.and_then(|r| match &r.action {
            Action::Run { into: Some(writer), .. } => {
                Some(PayloadWriter { writer: writer.clone(), trigger: format!("rule:{}", r.id) })
            }
            _ => None,
        })
    }
}

pub(crate) fn run_dir(home: &Path, id: &str) -> PathBuf {
    home.join("data/runs").join(id)
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

/// Starts the command under its holder, and waits for the holder on its own thread, which reports the exit to the
/// writer thread.
pub(crate) fn spawn(shared: &Arc<Shared>, job: Job) -> Result<u32> {
    let home = &shared.home;
    let hold = crate::hold_binary().ok_or_else(|| anyhow!("swb-hold not found next to the app or on PATH"))?;
    let env = shared.login_env.get_or_init(|| login_env(shared));
    let mut path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()).unwrap_or_default();
    let swb = crate::swb_binary();
    if let Some(dir) = swb.as_deref().and_then(Path::parent) {
        path = format!("{}:{path}", dir.display());
    }
    let dir = run_dir(home, &job.id);
    fs::create_dir_all(&dir)?;
    let mut command = Command::new(hold);
    command
        .arg(&dir)
        .arg(job.timeout.map_or(0, |t| t.as_secs().max(1)).to_string())
        .arg(if job.timeout.is_none() { "1" } else { "0" })
        .arg(&job.path)
        .env_clear()
        .envs(env.iter().cloned())
        .env("PATH", path)
        .env("RUN_ID", &job.id)
        .env("SWITCHBOARD_HOME", home)
        .env("SOURCE_DIR", job.path.ancestors().nth(2).unwrap_or(home))
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    if let Some(swb) = swb {
        command.env("SWB", swb);
    }
    for (name, value) in job.args.as_object().into_iter().flatten() {
        let name: String =
            name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
        command.env(format!("SWB_ARG_{name}"), display_text(value));
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    shared.children.lock().unwrap().insert(job.id.clone(), Child::process(pid));
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let args = job.args.to_string();
    // On its own thread: a command that never reads stdin must not block the writer thread.
    thread::spawn(move || _ = stdin.write_all(args.as_bytes()));
    let shared = shared.clone();
    thread::spawn(move || {
        let _ = child.wait();
        finish(&shared, &job.id, job.into.as_ref());
    });
    Ok(pid)
}

/// Takes over a run whose holder an earlier engine started: waits for the holder to release the run folder, then
/// records the exit as `spawn` would. A run without a folder is left for the tick to mark as lost.
pub(crate) fn adopt(shared: &Arc<Shared>, id: String, pid: Option<u32>, into: Option<PayloadWriter>) {
    let Ok(lock) = File::open(run_dir(&shared.home, &id)) else { return };
    shared.children.lock().unwrap().insert(id.clone(), Child::process(pid.unwrap_or(0)));
    let shared = shared.clone();
    thread::spawn(move || {
        // SAFETY: flock only reads the descriptor, which `lock` keeps open.
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_SH) };
        finish(&shared, &id, into.as_ref());
    });
}

/// Records how the held run ended, from its `exit`, and hands stdout to `into` or reads the outcome line from it.
fn finish(shared: &Arc<Shared>, id: &str, into: Option<&PayloadWriter>) {
    let report = ExitReport::new(shared, id.to_string());
    // Its process group may be reused from now on, so the engine must not signal it.
    shared.children.lock().unwrap().insert(id.to_string(), Child::InEngine);
    let dir = run_dir(&shared.home, id);
    let exit: Value =
        fs::read_to_string(dir.join("exit")).ok().and_then(|e| serde_json::from_str(&e).ok()).unwrap_or_default();
    let reason = exit["reason"].as_str().map(String::from);
    let (mut state, mut summary) = match (&reason, exit["code"].as_i64(), exit["signal"].as_i64()) {
        _ if exit.is_null() => (ExitState::Failure, Some("its holder exited without recording the exit".into())),
        (Some(r), ..) if r == "stopped" => (ExitState::Stopped, None),
        (Some(r), ..) => (ExitState::Failure, Some(r.clone())),
        (None, Some(0), _) => (ExitState::Success, None),
        (None, Some(code), _) => (ExitState::Failure, Some(format!("exited with exit status: {code}"))),
        (None, None, signal) => (ExitState::Failure, Some(format!("exited with signal: {}", signal.unwrap_or(0)))),
    };
    let out = dir.join("out");
    match into {
        None if reason.is_none() && !exit.is_null() => {
            let stdout = read_tail(&out).unwrap_or_default();
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
        Some(into) if exit["out_truncated"] == true => {
            state = ExitState::Failure;
            summary = Some(format!("stdout exceeded the 16 MB payload limit; nothing was written to {}", into.writer));
        }
        Some(into) if state == ExitState::Success => {
            let stdout = fs::read(&out).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            let origin = Origin { trigger: into.trigger.clone(), run_id: Some(id.to_string()) };
            let payload = Value::Object(Map::from_iter([("payload".into(), Value::String(stdout))]));
            match shared.write(&into.writer, payload, origin) {
                Ok(changes) => summary = Some(format!("{}: {changes} changes", into.writer)),
                Err(e) => (state, summary) = (ExitState::Failure, Some(format!("{e:#}"))),
            }
        }
        Some(_) => {}
    }
    report.send(state, summary);
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Writes a line to a long-running run's stdin, one writer at a time per run.
pub(crate) fn input(shared: &Shared, id: &str, text: &str) -> Result<()> {
    let lock = match shared.children.lock().unwrap().get(id) {
        Some(Child::Process { input, .. }) => input.clone(),
        _ => bail!("run {id} is not running"),
    };
    let _held = lock.lock().unwrap();
    let path = run_dir(&shared.home, id).join("in");
    let mut fifo = match OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&path) {
        Ok(fifo) => fifo,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!("run {id} takes no input: it is not long-running"),
        Err(e) => bail!("run {id} is not reading its input: {e}"),
    };
    // SAFETY: fcntl only changes the descriptor's flags, back to blocking writes.
    unsafe { libc::fcntl(fifo.as_raw_fd(), libc::F_SETFL, 0) };
    let mut line = text.to_string();
    if !line.ends_with('\n') {
        line.push('\n');
    }
    fifo.write_all(line.as_bytes())?;
    Ok(())
}

/// Asks a running command's holder to stop it: SIGTERM to its process group, SIGKILL after a grace period.
pub(crate) fn stop(shared: &Shared, id: &str) -> Result<bool> {
    match shared.children.lock().unwrap().get(id) {
        Some(Child::Process { pid, .. }) if *pid > 0 => {
            // SAFETY: kill has no memory-safety preconditions; the holder is alive while it is in `children`.
            unsafe { libc::kill(*pid as libc::pid_t, libc::SIGTERM) };
            Ok(true)
        }
        _ => Ok(false),
    }
}
