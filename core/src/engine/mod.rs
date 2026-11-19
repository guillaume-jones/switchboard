//! The engine: one writer thread owns every write, active reads are re-run after each commit that touches their
//! tables, and rules are evaluated on the writer thread from the results.

mod reads;
mod triggers;
mod writes;

use crate::loader::{BUILTINS, Diagnostic, Loaded, Mode, SystemEvent, load, load_core_only};
use anyhow::{Context, Result, anyhow, bail};
use notify::{RecursiveMode, Watcher};
use reads::{ReaderPool, Refresh, Subscriptions};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Receives what the engine pushes to the shell: `rows`, `config`, `card` and `notify`.
pub trait Emitter: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// What caused a write or a run, recorded with its events.
#[derive(Clone, Debug, Default)]
pub struct Origin {
    pub trigger: String,
    /// The run the write belongs to, which makes it the parent of the runs it causes.
    pub run_id: Option<String>,
}

const ENGINE_TRIGGER: &str = "engine";

impl Origin {
    /// The engine's own bookkeeping, which records no write events.
    pub(crate) fn engine() -> Origin {
        Origin { trigger: ENGINE_TRIGGER.into(), run_id: None }
    }

    fn is_engine(&self) -> bool {
        self.trigger == ENGINE_TRIGGER
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventKind {
    Write,
    Error,
    SlowRead,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            EventKind::Write => "write",
            EventKind::Error => "error",
            EventKind::SlowRead => "slow_read",
        }
    }
}

/// A row of `core.events`, buffered until the end of the batch.
pub(crate) struct Event {
    kind: EventKind,
    name: String,
    origin: Origin,
    message: String,
}

impl Event {
    pub(crate) fn error(trigger: &str, name: &str, message: impl Into<String>) -> Event {
        let origin = Origin { trigger: trigger.into(), run_id: None };
        Event { kind: EventKind::Error, name: name.into(), origin, message: message.into() }
    }
}

/// How a run ended, as reported by its runner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitState {
    Success,
    Failure,
    /// Still in progress outside the engine, until `swb run finish`.
    Open,
    /// Stopped by `swb run stop`.
    Stopped,
}

impl ExitState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ExitState::Success => "success",
            ExitState::Failure => "failure",
            ExitState::Open => "open",
            ExitState::Stopped => "stopped",
        }
    }

    pub(crate) fn parse(state: &str) -> Option<ExitState> {
        [ExitState::Success, ExitState::Failure, ExitState::Open].into_iter().find(|s| s.as_str() == state)
    }
}

/// A run being executed, which the tick must not mark as lost.
pub(crate) enum Child {
    /// Held by `swb-hold` with this pid; `input` serialises writes to its stdin.
    Process { pid: u32, input: Arc<Mutex<()>> },
    /// Nothing left to kill: a builtin, or a command that exited and whose result is being recorded.
    InEngine,
}

impl Child {
    pub(crate) fn process(pid: u32) -> Child {
        Child::Process { pid, input: Arc::default() }
    }
}

/// Reports a run's exit to the writer thread exactly once: as a failure if the thread running it panics first.
pub(crate) struct ExitReport {
    tx: Sender<Message>,
    id: Option<String>,
}

impl ExitReport {
    pub(crate) fn new(shared: &Shared, id: String) -> ExitReport {
        ExitReport { tx: shared.tx.clone(), id: Some(id) }
    }

    pub(crate) fn send(mut self, state: ExitState, summary: Option<String>) {
        if let Some(id) = self.id.take() {
            let _ = self.tx.send(Message::RunExited { id, state, summary });
        }
    }
}

impl Drop for ExitReport {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let summary = Some("the thread running it panicked".into());
            let _ = self.tx.send(Message::RunExited { id, state: ExitState::Failure, summary });
        }
    }
}

pub(crate) enum Message {
    Write {
        name: String,
        params: Value,
        origin: Origin,
        reply: Option<Sender<Result<usize>>>,
    },
    Run {
        command: String,
        args: Value,
        origin: Origin,
        /// Chosen by the caller, so that sending the same run twice starts it once.
        id: Option<String>,
        reply: Sender<Result<String>>,
    },
    Event(Event),
    /// A watched view's result changed: the rules watching it are evaluated against its rows.
    Evaluate {
        rules: Vec<String>,
        rows: Value,
        caused_by: Vec<String>,
    },
    RunExited {
        id: String,
        state: ExitState,
        summary: Option<String>,
    },
    Tick(i64),
    Triggered(triggers::Occurrence),
    Reload,
    Stop,
}

pub(crate) struct Shared {
    pub(crate) home: PathBuf,
    emitter: Box<dyn Emitter>,
    pub(crate) tx: Sender<Message>,
    triggers: triggers::Triggers,
    loaded: RwLock<Arc<Loaded>>,
    load_errors: RwLock<Vec<Diagnostic>>,
    /// Set while a reload waits for agent turns editing the folder to end.
    reload_pending: AtomicBool,
    /// False while only the core source runs because the folder failed to load at startup.
    folder_loaded: AtomicBool,
    readers: Mutex<ReaderPool>,
    subscriptions: Mutex<Subscriptions>,
    /// Incremented after every batch, so a subscription can tell whether a commit raced its first read.
    batches_committed: AtomicU64,
    /// Reads to re-run, for the refresh thread; `None` stops it.
    refresh_queue: Sender<Option<Vec<Refresh>>>,
    /// Run id → what executes it.
    pub(crate) children: Mutex<HashMap<String, Child>>,
    pub(crate) login_env: OnceLock<Vec<(String, String)>>,
    pub(crate) stopping: AtomicBool,
}

pub struct Engine {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    stop_ticker: Option<Sender<()>>,
    _watcher: notify::RecommendedWatcher,
    _lock: fs::File,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    ReadWrite,
    ReadOnly,
}

/// A connection with every source database attached and every view as a temp view.
fn connect(loaded: &Loaded, access: Access) -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.set_prepared_statement_cache_capacity(1024);
    for (name, source) in &loaded.sources {
        if let Some(db) = &source.db {
            conn.execute(&format!("ATTACH ?1 AS \"{name}\""), [db.to_string_lossy()])?;
            conn.execute_batch(&format!("PRAGMA \"{name}\".synchronous = NORMAL"))?;
        }
    }
    for (name, view) in &loaded.views {
        conn.execute(&format!("CREATE TEMP VIEW \"{name}\" AS {}", view.sql), [])?;
    }
    if access == Access::ReadOnly {
        conn.execute_batch("PRAGMA query_only = 1")?;
    }
    Ok(conn)
}

/// JSON as text: strings unquoted, null empty.
pub(crate) fn display_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

impl Shared {
    pub(crate) fn loaded(&self) -> Arc<Loaded> {
        self.loaded.read().unwrap().clone()
    }

    pub(crate) fn record(&self, event: Event) {
        let _ = self.tx.send(Message::Event(event));
    }

    pub(crate) fn write(&self, name: &str, params: Value, origin: Origin) -> Result<usize> {
        let (reply, result) = channel();
        self.tx
            .send(Message::Write { name: name.into(), params, origin, reply: Some(reply) })
            .map_err(|_| anyhow!("engine stopped"))?;
        result.recv().map_err(|_| anyhow!("engine stopped"))?
    }

    pub(crate) fn run(&self, name: &str, args: Value, origin: Origin, id: Option<String>) -> Result<String> {
        if !self.loaded().commands.contains_key(name) && !BUILTINS.contains(&name) {
            bail!("no command named {name}");
        }
        let (reply, result) = channel();
        let message = Message::Run { command: name.into(), args, origin, id, reply };
        self.tx.send(message).map_err(|_| anyhow!("engine stopped"))?;
        result.recv().map_err(|_| anyhow!("engine stopped"))?
    }

    pub(crate) fn finish_run(&self, run_id: &str, ok: bool, summary: Option<&str>) -> Result<()> {
        let state = if ok { ExitState::Success } else { ExitState::Failure };
        let params = json!({ "id": run_id, "state": state.as_str(), "summary": summary });
        let origin = Origin { trigger: "swb".into(), run_id: Some(run_id.into()) };
        match self.write("core.run_finish", params, origin)? {
            0 => bail!("run {run_id} is not running or open"),
            _ => Ok(()),
        }
    }

    pub(crate) fn input_run(&self, run_id: &str, text: &str) -> Result<()> {
        crate::runner::input(self, run_id, text)
    }

    /// Stops a running command through its holder, or a queued run before it starts.
    pub(crate) fn stop_run(&self, run_id: &str) -> Result<()> {
        if crate::runner::stop(self, run_id)? {
            return Ok(());
        }
        let params = json!({ "id": run_id, "state": ExitState::Stopped.as_str(), "summary": null });
        let origin = Origin { trigger: "swb".into(), run_id: Some(run_id.into()) };
        match self.write("core.run_exit", params, origin)? {
            0 => bail!("run {run_id} is not running or queued"),
            _ => Ok(()),
        }
    }

    /// Registers the rules' views as active reads, evaluates them, watches their files, and records the rule set in
    /// `core.rules`.
    fn sync_rules(&self, loaded: &Loaded) {
        for e in self.triggers.watch(loaded) {
            self.record(Event::error("engine", "when.files", format!("{e:#}")));
        }
        if self.folder_loaded.load(SeqCst) {
            let rules: Vec<&String> = loaded.rules.keys().collect();
            let params = json!({ "payload": rules });
            let _ = self.tx.send(Message::Write {
                name: "core.rules_sync".into(),
                params,
                origin: Origin::engine(),
                reply: None,
            });
        }
        let refreshes = self.watch_rule_views(loaded);
        self.refresh(refreshes);
    }

    /// Whether a row of the `editing` view puts an agent turn in this folder.
    fn editing(&self, conn: &Connection) -> bool {
        let view = &self.loaded().settings.editing;
        if view.is_empty() {
            return false;
        }
        let Ok(mut statement) = conn.prepare_cached(&format!("SELECT cwd FROM \"{view}\"")) else { return false };
        let Ok(rows) = statement.query_map([], |row| row.get::<_, Option<String>>(0)) else { return false };
        rows.flatten().flatten().any(|cwd| fs::canonicalize(cwd).is_ok_and(|cwd| cwd.starts_with(&self.home)))
    }

    /// Swaps in a clean load of the folder; otherwise keeps the current one and reports its new errors. Unless forced,
    /// waits while an agent turn is editing the folder, so a half-made change never runs.
    fn reload(&self, conn: &mut Connection, force: bool) {
        if !force && self.editing(conn) {
            self.reload_pending.store(true, SeqCst);
            return;
        }
        self.reload_pending.store(false, SeqCst);
        let loaded = match load(&self.home, Mode::Apply) {
            Ok(loaded) => Arc::new(loaded),
            Err(diagnostics) => {
                {
                    let mut reported = self.load_errors.write().unwrap();
                    for d in diagnostics.iter().filter(|d| d.is_error() && !reported.contains(d)) {
                        self.record(Event::error("loader", &d.path, d.message.clone()));
                    }
                    *reported = diagnostics;
                }
                self.emitter.emit("config", Value::Null);
                return;
            }
        };
        match connect(&loaded, Access::ReadWrite) {
            Ok(new) => *conn = new,
            Err(e) => return self.record(Event::error("loader", "engine", format!("{e:#}"))),
        }
        let previous = std::mem::replace(&mut *self.loaded.write().unwrap(), loaded.clone());
        self.load_errors.write().unwrap().clear();
        self.folder_loaded.store(true, SeqCst);
        self.readers.lock().unwrap().invalidate();
        let refreshes = self.resolve_reads_again(&loaded);
        self.refresh(refreshes);
        self.sync_rules(&loaded);
        self.emitter.emit("config", Value::Null);
        for (name, bundle) in &loaded.cards {
            if previous.cards.get(name) != Some(bundle) {
                self.emitter.emit("card", json!({ "name": name }));
            }
        }
    }
}

impl Engine {
    pub fn open(home: &Path, emitter: impl Emitter + 'static) -> Result<Engine> {
        crate::raise_fd_limit();
        if !home.exists() {
            crate::maintenance::init(home, crate::maintenance::Template::BuiltIn, false)?;
        }
        let home = home.canonicalize().with_context(|| format!("cannot open {}", home.display()))?;
        fs::create_dir_all(home.join("data"))?;
        let lock = fs::File::create(home.join("data/engine.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => {
                bail!("another instance of the app is already running on {}", home.display())
            }
            Err(fs::TryLockError::Error(e)) => return Err(e).context("cannot lock data/engine.lock"),
        }
        let (loaded, load_errors) = match load(&home, Mode::Apply) {
            Ok(loaded) => (loaded, Vec::new()),
            Err(diagnostics) => {
                let core = load_core_only(&home, Mode::Apply)
                    .map_err(|d| anyhow!(d.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")))?;
                (core, diagnostics)
            }
        };
        let loaded = Arc::new(loaded);
        let conn = connect(&loaded, Access::ReadWrite)?;
        let held: Vec<(String, Option<u32>, Option<String>)> = conn
            .prepare("SELECT id, pid, rule FROM core.runs WHERE state = 'running'")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;

        let socket = home.join("data/swb.sock");
        let _ = fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).with_context(|| format!("cannot bind {}", socket.display()))?;

        let (changed, changes) = channel();
        let ignored = [home.join("data"), home.join(".git"), home.join("cards/switchboard.d.ts")];
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            // inotify also reports reads, such as the engine's own while loading.
            let changed_paths = event.is_ok_and(|e| {
                !matches!(e.kind, notify::EventKind::Access(_))
                    && e.paths.iter().any(|p| !ignored.iter().any(|i| p.starts_with(i)))
            });
            if changed_paths {
                let _ = changed.send(());
            }
        })?;
        watcher.watch(&home, RecursiveMode::Recursive).map_err(|e| anyhow!(triggers::watch_error(&e)))?;

        let (tx, rx) = channel();
        let (refresh_queue, queued_refreshes) = channel();
        let shared = Arc::new(Shared {
            home: home.clone(),
            emitter: Box::new(emitter),
            tx: tx.clone(),
            triggers: triggers::Triggers::new(tx.clone()),
            loaded: RwLock::new(loaded.clone()),
            load_errors: RwLock::new(load_errors.clone()),
            reload_pending: AtomicBool::new(false),
            folder_loaded: AtomicBool::new(load_errors.is_empty()),
            readers: Mutex::default(),
            subscriptions: Mutex::default(),
            batches_committed: AtomicU64::new(0),
            refresh_queue,
            children: Mutex::default(),
            login_env: OnceLock::new(),
            stopping: AtomicBool::new(false),
        });
        for d in load_errors.iter().filter(|d| d.is_error()) {
            shared.record(Event::error("loader", &d.path, d.message.clone()));
        }
        for (id, pid, rule) in held {
            let into = crate::runner::PayloadWriter::of(rule.and_then(|r| loaded.rules.get(&r)));
            crate::runner::adopt(&shared, id, pid, into);
        }
        let mut threads = Vec::new();
        let writer = writes::WriteLoop::new(shared.clone(), conn);
        threads.push(thread::spawn(move || writer.run(rx)));
        let s = shared.clone();
        threads.push(thread::spawn(move || s.refresh_loop(&queued_refreshes)));
        shared.sync_rules(&loaded);
        let s = shared.clone();
        thread::spawn(move || _ = s.login_env.get_or_init(|| crate::runner::login_env(&s)));

        let s = shared.clone();
        threads.push(thread::spawn(move || crate::socket::serve(&s, listener)));

        let s = shared.clone();
        let (stop_ticker, ticker_stopped) = channel::<()>();
        threads.push(thread::spawn(move || {
            loop {
                let now = crate::now_ms();
                let _ = s.tx.send(Message::Tick(now));
                crate::maintenance::take_due_snapshots(&s.home, &s.loaded(), now);
                let until_next_minute = 60_000 - crate::now_ms().rem_euclid(60_000) + 50;
                let wait = Duration::from_millis(until_next_minute.unsigned_abs());
                if ticker_stopped.recv_timeout(wait) != Err(RecvTimeoutError::Timeout) {
                    break;
                }
            }
        }));

        // Debounced: one reload once the folder has been quiet for 100 ms.
        thread::spawn(move || {
            while changes.recv().is_ok() {
                while changes.recv_timeout(Duration::from_millis(100)).is_ok() {}
                if tx.send(Message::Reload).is_err() {
                    break;
                }
            }
        });
        crate::maintenance::install_hook(&home);
        Ok(Engine { shared, threads, stop_ticker: Some(stop_ticker), _watcher: watcher, _lock: lock })
    }

    pub fn subscribe(&self, name: &str, params: Value) -> Result<(u64, Value)> {
        self.shared.subscribe(name, params)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.shared.unsubscribe(id)
    }

    pub fn query(&self, name: &str, params: Value) -> Result<Value> {
        self.shared.query(name, params)
    }

    pub fn write(&self, name: &str, params: Value, origin: Origin) -> Result<usize> {
        self.shared.write(name, params, origin)
    }

    /// Queues a run of a command by hand, which no limit applies to, and returns its id.
    pub fn run(&self, name: &str, args: Value, origin: Origin) -> Result<String> {
        self.shared.run(name, args, origin, None)
    }

    /// `run` with an id chosen by the caller: a run that already has this id is not started again.
    pub fn run_as(&self, id: &str, name: &str, args: Value, origin: Origin) -> Result<String> {
        self.shared.run(name, args, origin, Some(id.into()))
    }

    pub fn finish_run(&self, run_id: &str, ok: bool, summary: Option<&str>) -> Result<()> {
        self.shared.finish_run(run_id, ok, summary)
    }

    /// Writes a line to a long-running run's stdin.
    pub fn input_run(&self, run_id: &str, text: &str) -> Result<()> {
        self.shared.input_run(run_id, text)
    }

    pub fn stop_run(&self, run_id: &str) -> Result<()> {
        self.shared.stop_run(run_id)
    }

    /// Connects to a `pty` run's terminal, waiting briefly for a run that has not started yet.
    pub fn pty(&self, run_id: &str) -> Result<crate::Pty> {
        crate::Pty::connect(&self.shared.home, run_id)
    }

    /// What the shell needs to render: the root card, the palette entries, key bindings and load errors.
    pub fn config(&self) -> Value {
        let loaded = self.shared.loaded();
        let sources: Map<String, Value> = loaded
            .sources
            .iter()
            .map(|(name, source)| (name.clone(), json!({ "item_card": source.config.item_card })))
            .collect();
        let errors: Vec<Value> = self
            .shared
            .load_errors
            .read()
            .unwrap()
            .iter()
            .filter(|d| d.is_error())
            .map(|d| json!({ "path": d.path, "message": d.message }))
            .collect();
        let queue_expiry: Map<String, Value> = loaded
            .sources
            .iter()
            .flat_map(|(name, source)| {
                source
                    .config
                    .queue_expiry
                    .iter()
                    .map(move |(command, expiry)| (format!("{name}.{command}"), expiry.as_secs().into()))
            })
            .collect();
        json!({
            "root": loaded.settings.root,
            "depth_cap": loaded.settings.depth_cap,
            "queue_run_expiry": loaded.settings.queue_run_expiry.as_secs(),
            "reconnect_timeout": loaded.settings.reconnect_timeout.as_secs(),
            "connect_timeout": loaded.settings.connect_timeout.as_secs(),
            "queue_expiry": queue_expiry,
            "sources": sources,
            "cards": loaded.cards.keys().collect::<Vec<_>>(),
            "commands": loaded.commands.keys().map(String::as_str).chain(BUILTINS).collect::<Vec<_>>(),
            "writers": loaded.writers.keys().collect::<Vec<_>>(),
            "keymap": loaded.keymap,
            "errors": errors,
        })
    }

    pub fn card(&self, name: &str) -> Result<Value> {
        match self.shared.loaded().cards.get(name) {
            Some(bundle) => Ok(json!(bundle)),
            None => bail!("no card named {name}"),
        }
    }

    pub fn revert_last_commit(&self) -> Result<()> {
        let out = std::process::Command::new("git")
            .current_dir(&self.shared.home)
            .args(["-c", "core.hooksPath=/dev/null", "revert", "--no-edit", "HEAD"])
            .output()?;
        if !out.status.success() {
            bail!("git revert failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(())
    }

    pub fn report_error(&self, card: &str, message: &str, stack: &str) {
        self.error("card_runtime", card, format!("{message}\n{stack}").trim());
    }

    pub fn error(&self, trigger: &str, name: &str, message: &str) {
        self.shared.record(Event::error(trigger, name, message));
    }

    pub fn loaded(&self) -> Arc<Loaded> {
        self.shared.loaded()
    }

    /// Fires the rules with this `when.system` event. `offline` fires only once it has lasted `offline_debounce`,
    /// and `online` only after an `offline` fired.
    pub fn system_event(&self, event: SystemEvent) {
        self.shared.triggers.system(event, self.shared.loaded().settings.offline_debounce);
    }

    /// Runs the minute tick now, as if the clock read `now_ms`.
    #[doc(hidden)]
    pub fn tick(&self, now_ms: i64) {
        let _ = self.shared.tx.send(Message::Tick(now_ms));
        crate::maintenance::take_due_snapshots(&self.shared.home, &self.shared.loaded(), now_ms);
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shared.stopping.store(true, SeqCst);
        let _ = self.shared.tx.send(Message::Stop);
        self.stop_ticker.take();
        // Wakes the socket thread, blocked in accept, so it sees `stopping`. Running commands keep running under
        // their holders, for the next engine to adopt.
        let _ = UnixStream::connect(self.shared.home.join("data/swb.sock"));
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        let _ = fs::remove_file(self.shared.home.join("data/swb.sock"));
    }
}
