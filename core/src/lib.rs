mod engine;
mod loader;
mod maintenance;
mod runner;
mod socket;

pub use engine::{Emitter, Engine, Origin};
pub use maintenance::{Template, init};
pub use loader::{
    Action, BUILTINS, CardBundle, Diagnostic, FileWatch, Level, Loaded, Mode, Rule, SHELL_COMMANDS, Select, Settings,
    Source, SourceConfig, Statement, SystemEvent, Trigger, Watch, Writer, load,
};

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(crate) const DAY_MS: i64 = 86_400_000;

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
    if let Some(path) = std::env::var_os("SWITCHBOARD_SWB") {
        return Some(path.into());
    }
    let exe = std::env::current_exe().ok();
    let beside_exe = exe.iter().flat_map(|e| e.ancestors().skip(1).take(2).map(Path::to_path_buf));
    let on_path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    beside_exe.chain(on_path).map(|dir| dir.join("swb")).find(|p| p.is_file())
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

/// Sends SIGKILL to the process group led by `pid`: commands run in their own group, so this also reaches
/// everything they started.
pub(crate) fn kill_process_group(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return };
    if pid > 0 {
        // SAFETY: kill has no memory-safety preconditions; a negative pid addresses the process group.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
}
