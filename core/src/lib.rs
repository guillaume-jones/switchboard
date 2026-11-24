mod engine;
mod loader;
mod maintenance;
mod pty;
mod runner;
mod socket;

pub use engine::{Emitter, Engine, Origin};
pub use loader::{
    Action, BUILTINS, CardBundle, CardCode, Diagnostic, FileWatch, Level, Loaded, Mode, Rule, SHELL_COMMANDS, Select,
    Settings, Source, SourceConfig, Statement, SystemEvent, Trigger, Watch, Writer, load, reload,
};
pub use maintenance::{Template, init};
pub use pty::Pty;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) const DAY_MS: i64 = 86_400_000;

/// A short hash of `text`, naming content that is unchanged while it is.
pub fn digest(text: &str) -> String {
    use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};
    format!("{:016x}", BuildHasherDefault::<DefaultHasher>::default().hash_one(text))
}

/// The folder: `$SWITCHBOARD_HOME`, else `~/.switchboard`.
pub fn home() -> PathBuf {
    match std::env::var_os("SWITCHBOARD_HOME") {
        Some(home) => home.into(),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".switchboard"),
    }
}

/// The `swb` CLI: `$SWITCHBOARD_SWB`, else next to this executable or in its parent directory (the app bundle or
/// Cargo's target directory), else on `PATH`.
pub(crate) fn swb_binary() -> Option<PathBuf> {
    sibling_binary("swb", "SWITCHBOARD_SWB")
}

/// `swb-hold`, which holds each run: found like `swb`, with `$SWITCHBOARD_HOLD`.
pub(crate) fn hold_binary() -> Option<PathBuf> {
    sibling_binary("swb-hold", "SWITCHBOARD_HOLD")
}

fn sibling_binary(name: &str, var: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(var) {
        return Some(path.into());
    }
    let exe = std::env::current_exe().ok();
    let beside_exe = exe.iter().flat_map(|e| e.ancestors().skip(1).take(2).map(Path::to_path_buf));
    let on_path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    beside_exe.chain(on_path).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// A directory's entries as (file name, path), sorted by name, without hidden files. Empty if it cannot be read.
pub(crate) fn sorted_entries(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    entries.sort();
    entries
}

/// Milliseconds since the Unix epoch: the unit of every timestamp in `core`.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, millis)
}

pub(crate) fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// Whether a process with this id exists, including one we may not signal.
pub(crate) fn process_exists(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // SAFETY: signal 0 performs only the existence and permission checks; nothing is delivered.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Every reader connection attaches each source's database and WAL, so the file count grows with connections ×
/// sources; apps started by launchd get a soft limit of 256. macOS refuses limits above OPEN_MAX.
pub(crate) fn raise_fd_limit() {
    const OPEN_MAX: libc::rlim_t = 10240;
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit and setrlimit only read and write the rlimit passed to them.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 && limit.rlim_cur < OPEN_MAX.min(limit.rlim_max) {
            limit.rlim_cur = OPEN_MAX.min(limit.rlim_max);
            libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
        }
    }
}

/// Sends SIGKILL to the process group led by `pid`: commands run in their own group, so this also reaches
/// everything they started.
pub(crate) fn kill_process_group(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return };
    if pid > 0 {
        // SAFETY: kill has no memory-safety preconditions; a negative pid addresses the process group.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
}
