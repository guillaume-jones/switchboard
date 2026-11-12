//! The folder's housekeeping: first-run setup, the pre-commit hook, snapshots, restores and orphaned databases.

use crate::loader::Loaded;
use crate::{DAY_MS, millis, now_ms, sorted_entries};
use anyhow::{Result, anyhow};
use include_dir::{Dir, include_dir};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::SystemTime;

static TEMPLATE: Dir = include_dir!("$CARGO_MANIFEST_DIR/../template");
const HOOK_MARKER: &str = "switchboard pre-commit hook";
const TRASH_RETENTION_MS: i64 = 30 * DAY_MS;

/// Creates the folder from the template as a git repository with the pre-commit hook, and commits it.
pub(crate) fn first_run(home: &Path) -> Result<()> {
    fs::create_dir_all(home)?;
    TEMPLATE.extract(home)?;
    for (_, source) in sorted_entries(&home.join("sources")) {
        for (_, command) in sorted_entries(&source.join("commands")) {
            fs::set_permissions(command, fs::Permissions::from_mode(0o755))?;
        }
    }
    fs::write(home.join(".gitignore"), "data/\ncards/switchboard.d.ts\n")?;
    let git =
        |args: &[&str]| Command::new("git").current_dir(home).args(args).output().is_ok_and(|o| o.status.success());
    if git(&["init", "-q"]) {
        install_hook(home);
        git(&["add", "-A"]);
        let commit = ["commit", "-q", "--no-verify", "-m", "Initial switchboard folder"];
        if !git(&commit) {
            // Without a configured git identity.
            let identity = ["-c", "user.name=Switchboard", "-c", "user.email=switchboard@localhost"];
            git(&[identity.as_slice(), commit.as_slice()].concat());
        }
    }
    Ok(())
}

/// Writes the hook that runs `swb check` before every commit, unless the folder has a hook of its own.
pub(crate) fn install_hook(home: &Path) {
    let hook = home.join(".git/hooks/pre-commit");
    let is_repository = hook.parent().is_some_and(Path::is_dir);
    let has_own_hook = fs::read_to_string(&hook).is_ok_and(|h| !h.contains(HOOK_MARKER));
    if !is_repository || has_own_hook {
        return;
    }
    let swb = crate::swb_binary().map_or("swb".into(), |p| p.display().to_string());
    let script = format!(
        "#!/bin/sh\n# {HOOK_MARKER}, rewritten by the app on every start\nSWB='{swb}'\n[ -x \"$SWB\" ] || SWB=\"$(command -v swb)\"\n[ -n \"$SWB\" ] || {{ echo 'switchboard: swb not found, cannot check the folder (git commit --no-verify skips the check)' >&2; exit 1; }}\nSWITCHBOARD_HOME=\"$(git rev-parse --show-toplevel)\" exec \"$SWB\" check\n"
    );
    if fs::write(&hook, script).is_ok() {
        let _ = fs::set_permissions(&hook, fs::Permissions::from_mode(0o755));
    }
}

/// Copies the database to `data/snapshots/<source>/<ms>.db`.
pub(crate) fn snapshot(home: &Path, source: &str, db: &Path) -> Result<PathBuf> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let dir = home.join("data/snapshots").join(source);
    fs::create_dir_all(&dir)?;
    let _guard = ONE_AT_A_TIME.lock().unwrap();
    let mut taken_at = now_ms();
    while dir.join(format!("{taken_at}.db")).exists() {
        taken_at += 1;
    }
    let path = dir.join(format!("{taken_at}.db"));
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
    Ok(path)
}

struct Snapshot {
    taken_at: i64,
    path: PathBuf,
}

/// Oldest first.
fn snapshots_of(home: &Path, source: &str) -> Vec<Snapshot> {
    let mut snapshots: Vec<Snapshot> = sorted_entries(&home.join("data/snapshots").join(source))
        .into_iter()
        .filter_map(|(name, path)| Some(Snapshot { taken_at: name.strip_suffix(".db")?.parse().ok()?, path }))
        .collect();
    snapshots.sort_by_key(|s| s.taken_at);
    snapshots
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    modified.duration_since(SystemTime::UNIX_EPOCH).ok().map(millis)
}

/// Snapshots each database changed since its latest snapshot once `snapshot_interval` has passed, and deletes
/// snapshots past `snapshot_retention`, always keeping the latest.
pub(crate) fn take_due_snapshots(home: &Path, loaded: &Loaded, now: i64) {
    for (name, source) in &loaded.sources {
        let Some(db) = &source.db else { continue };
        let interval = millis(source.config.snapshot_interval.unwrap_or(loaded.settings.snapshot_interval));
        let retention = millis(source.config.snapshot_retention.unwrap_or(loaded.settings.snapshot_retention));
        let snapshots = snapshots_of(home, name);
        let mut wal = db.as_os_str().to_owned();
        wal.push("-wal");
        let changed = modified_ms(db).max(modified_ms(Path::new(&wal)));
        let due = match snapshots.last() {
            None => true,
            Some(latest) => now - latest.taken_at >= interval && changed.is_some_and(|c| c >= latest.taken_at),
        };
        if due {
            let _ = snapshot(home, name, db);
        }
        let expired = snapshots.iter().rev().skip(1).filter(|s| s.taken_at < now.saturating_sub(retention));
        for snapshot in expired {
            let _ = fs::remove_file(&snapshot.path);
        }
    }
}

/// Snapshots the source's current data, then restores `args.snapshot` (default: the latest) into `conn`.
pub(crate) fn restore(home: &Path, conn: &mut Connection, loaded: &Loaded, args: &Value) -> Result<PathBuf> {
    let usage =
        "core.restore needs {\"source\": name}, and optionally {\"snapshot\": <timestamp>} (default: the latest)";
    let source = args["source"].as_str().ok_or_else(|| anyhow!(usage))?;
    let db = loaded
        .sources
        .get(source)
        .and_then(|s| s.db.as_ref())
        .ok_or_else(|| anyhow!("{source} is not a source with a database"))?;
    let snapshots = snapshots_of(home, source);
    let chosen = match args["snapshot"].as_i64() {
        Some(taken_at) => snapshots.iter().find(|s| s.taken_at == taken_at),
        None => snapshots.last(),
    };
    let path = chosen.ok_or_else(|| anyhow!("no such snapshot of {source}"))?.path.clone();
    snapshot(home, source, db)?;
    conn.restore(source, &path, None::<fn(rusqlite::backup::Progress)>)?;
    Ok(path)
}

/// Moves databases whose source is gone to `data/trash/`, and deletes trashed databases after 30 days.
pub(crate) fn trash_orphaned_databases(home: &Path, loaded: &Loaded, now: i64) {
    let trash = home.join("data/trash");
    for (name, path) in sorted_entries(&home.join("data")) {
        let Some(source) = name.strip_suffix(".db") else { continue };
        if loaded.sources.get(source).is_some_and(|s| s.db.is_some()) || fs::create_dir_all(&trash).is_err() {
            continue;
        }
        for suffix in ["", "-wal", "-shm"] {
            let mut from = OsString::from(path.as_os_str());
            from.push(suffix);
            let _ = fs::rename(from, trash.join(format!("{source}.{now}.db{suffix}")));
        }
    }
    for (name, path) in sorted_entries(&trash) {
        let trashed_at = name.split('.').nth(1).and_then(|t| t.parse::<i64>().ok());
        if trashed_at.is_some_and(|t| t < now - TRASH_RETENTION_MS) {
            let _ = fs::remove_file(path);
        }
    }
}
