//! Turns file changes and system events into trigger occurrences for the writer thread: a changed file once it has
//! been quiet for `QUIET` (or, when only `line_contains` rules watch it, at most `MAX_WAIT` after its first change),
//! `offline` once the network has stayed unreachable for `offline_debounce`.

use super::{Event, Message};
use crate::loader::{FileWatch, Loaded, SystemEvent, Trigger};
use anyhow::anyhow;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

const QUIET: Duration = Duration::from_millis(200);
/// Complete lines can be read while the file is still being written, so a file appended to continuously still fires.
const MAX_WAIT: Duration = Duration::from_secs(1);
/// More appended at once is skipped rather than read, such as a file that was replaced.
const MAX_APPENDED: u64 = 64 << 20;

/// notify's error, with the fix when it is Linux's inotify watch limit.
pub(super) fn watch_error(e: &notify::Error) -> String {
    match e.kind {
        notify::ErrorKind::MaxFilesWatch => format!("{e} Raise the fs.inotify.max_user_watches sysctl."),
        _ => e.to_string(),
    }
}

pub(crate) enum Occurrence {
    /// `lines` holds the appended lines, with their offsets, that some rule's `line_contains` matches.
    File {
        path: PathBuf,
        lines: Vec<(u64, String)>,
    },
    System(SystemEvent),
}

enum Input {
    Watch(Vec<FileWatch>),
    Changed(PathBuf),
    System(SystemEvent, Duration),
}

pub(super) struct Triggers {
    input: Sender<Input>,
    tx: Sender<Message>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl Triggers {
    pub(super) fn new(tx: Sender<Message>) -> Triggers {
        let (input, inputs) = channel();
        let delivered = tx.clone();
        thread::spawn(move || deliver(&inputs, &delivered));
        Triggers { input, tx, watcher: Mutex::default() }
    }

    /// Replaces the watcher with one for the loaded rules' `when.files`, and returns the roots it cannot watch. Roots
    /// that do not exist, such as another app's folder before its first run, are skipped until the next reload.
    pub(super) fn watch(&self, loaded: &Loaded) -> Vec<anyhow::Error> {
        let files: Vec<FileWatch> = loaded
            .rules
            .values()
            .filter_map(|rule| match &rule.trigger {
                Some(Trigger::Files(files)) => Some(files.clone()),
                _ => None,
            })
            .collect();
        let mut current = self.watcher.lock().unwrap();
        *current = None;
        let _ = self.input.send(Input::Watch(files.clone()));
        if files.is_empty() {
            return Vec::new();
        }
        let (input, tx, patterns) = (self.input.clone(), self.tx.clone(), files.clone());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event.inspect_err(|e| {
                let _ = tx.send(Message::Event(Event::error("engine", "when.files", watch_error(e))));
            }) else {
                return;
            };
            if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                for path in event.paths.into_iter().filter(|p| patterns.iter().any(|f| f.matches(p))) {
                    let _ = input.send(Input::Changed(path));
                }
            }
        });
        let mut watcher = match watcher {
            Ok(watcher) => watcher,
            Err(e) => return vec![e.into()],
        };
        let roots: BTreeSet<&PathBuf> = files.iter().map(|f| &f.root).filter(|root| root.exists()).collect();
        let errors = roots
            .into_iter()
            .filter_map(|root| {
                watcher
                    .watch(root, RecursiveMode::Recursive)
                    .map_err(|e| anyhow!("cannot watch {}: {}", root.display(), watch_error(&e)))
                    .err()
            })
            .collect();
        *current = Some(watcher);
        errors
    }

    pub(super) fn system(&self, event: SystemEvent, offline_debounce: Duration) {
        let _ = self.input.send(Input::System(event, offline_debounce));
    }
}

/// Runs until the engine drops its `Triggers` and stops its writer thread.
fn deliver(inputs: &Receiver<Input>, tx: &Sender<Message>) {
    let mut files: Vec<FileWatch> = Vec::new();
    let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
    // Path → its first and latest change since it last fired.
    let mut changed: HashMap<PathBuf, (Instant, Instant)> = HashMap::new();
    let mut online = true;
    let mut offline_at: Option<Instant> = None;
    loop {
        let next = changed.iter().map(|(path, at)| due(&files, path, *at)).chain(offline_at).min();
        let input = match next {
            Some(deadline) => inputs.recv_timeout(deadline.saturating_duration_since(Instant::now())),
            None => inputs.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let mut occurrences = Vec::new();
        match input {
            Ok(Input::Watch(watched)) => {
                files = watched;
                let previous = std::mem::take(&mut offsets);
                offsets = files
                    .iter()
                    .filter(|f| f.line_contains.is_some())
                    .flat_map(FileWatch::existing)
                    .filter_map(|path| {
                        let len = path.metadata().ok()?.len();
                        let offset = previous.get(&path).copied().filter(|&offset| offset <= len).unwrap_or(len);
                        Some((path, offset))
                    })
                    .collect();
                changed.retain(|path, _| files.iter().any(|f| f.matches(path)));
            }
            Ok(Input::Changed(path)) => {
                let now = Instant::now();
                changed.entry(path).and_modify(|(_, latest)| *latest = now).or_insert((now, now));
            }
            Ok(Input::System(SystemEvent::Offline, debounce)) => {
                if online && offline_at.is_none() {
                    offline_at = Some(Instant::now() + debounce);
                }
            }
            Ok(Input::System(SystemEvent::Online, _)) => {
                if offline_at.take().is_none() && !online {
                    online = true;
                    occurrences.push(Occurrence::System(SystemEvent::Online));
                }
            }
            Ok(Input::System(event, _)) => occurrences.push(Occurrence::System(event)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        if offline_at.is_some_and(|at| at <= now) {
            (offline_at, online) = (None, false);
            occurrences.push(Occurrence::System(SystemEvent::Offline));
        }
        let quiet: Vec<PathBuf> =
            changed.iter().filter(|(path, at)| due(&files, path, **at) <= now).map(|(p, _)| p.clone()).collect();
        for path in quiet {
            changed.remove(&path);
            let matching: Vec<&FileWatch> = files.iter().filter(|f| f.matches(&path)).collect();
            let needles: Vec<&str> = matching.iter().filter_map(|f| f.line_contains.as_deref()).collect();
            let mut lines = Vec::new();
            if !needles.is_empty() {
                let from = offsets.get(&path).copied().unwrap_or(0);
                let (to, appended) = appended_lines(&path, from, &needles).unwrap_or((from, Vec::new()));
                offsets.insert(path.clone(), to);
                lines = appended;
            }
            if !lines.is_empty() || matching.iter().any(|f| f.line_contains.is_none()) {
                occurrences.push(Occurrence::File { path, lines });
            }
        }
        for occurrence in occurrences {
            if tx.send(Message::Triggered(occurrence)).is_err() {
                return;
            }
        }
    }
}

/// When a changed file fires: once quiet, or at most `MAX_WAIT` after its first change if only lines are read from it,
/// since a rule on the whole file must not see it half-written.
fn due(files: &[FileWatch], path: &Path, (first, latest): (Instant, Instant)) -> Instant {
    let quiet = latest + QUIET;
    if files.iter().filter(|f| f.matches(path)).all(|f| f.line_contains.is_some()) {
        quiet.min(first + MAX_WAIT)
    } else {
        quiet
    }
}

/// The complete lines written past `from` that contain one of `needles`, and the offset after the last complete line.
fn appended_lines(path: &Path, from: u64, needles: &[&str]) -> io::Result<(u64, Vec<(u64, String)>)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < from || len - from > MAX_APPENDED {
        return Ok((len, Vec::new()));
    }
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut at = from;
    let lines = bytes[..complete]
        .split_inclusive(|b| *b == b'\n')
        .filter_map(|line| {
            let start = at;
            at += line.len() as u64;
            let text = String::from_utf8_lossy(line);
            needles.iter().any(|n| text.contains(n)).then(|| (start, text.trim_end().to_string()))
        })
        .collect();
    Ok((at, lines))
}
