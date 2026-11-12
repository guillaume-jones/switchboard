//! The writer thread: drains every pending message into one transaction (group commit), fires rules, starts
//! queued runs, writes the batch's events, commits, then re-runs the reads the batch dirtied.

use super::reads::{DirtyTables, bind, query_rows, reject_unknown_params};
use super::{Child, Event, EventKind, ExitReport, ExitState, Message, Origin, Shared, display_text};
use crate::loader::{Action, Builtin, Loaded, Rule, Writer, template_vars};
use crate::runner::{Job, PayloadWriter};
use crate::{DAY_MS, millis, now_ms};
use anyhow::{Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

const HOUR_MS: i64 = 3_600_000;
const BEGIN_RETRY_DELAY: Duration = Duration::from_millis(100);
/// Firings keyed by schedule slot are only needed until their slot cannot recur.
const SLOT_FIRING_RETENTION_MS: i64 = 7 * DAY_MS;

pub(super) struct WriteLoop {
    shared: Arc<Shared>,
    conn: Connection,
    memory: RuleMemory,
}

#[derive(Default)]
struct RuleMemory {
    /// Each rule's keys in `core.firings`, loaded on its first evaluation.
    fired_keys: HashMap<String, HashSet<String>>,
    /// When each rule last evaluated its view, written to `core.rules` on the next tick rather than on every
    /// evaluation.
    last_evaluated: HashMap<String, i64>,
}

/// What a batch leaves to do once it has committed.
#[derive(Default)]
struct Settled {
    write_replies: Vec<(Sender<Result<usize>>, Result<usize>)>,
    run_replies: Vec<(Sender<Result<String>>, Result<String>)>,
    /// `core.restore` runs, which replace a database and so cannot run inside the transaction.
    restores: Vec<(String, Value)>,
    enabled_rules: Vec<String>,
    dirty: DirtyTables,
    reload: bool,
    stop: bool,
    /// Messages without a reply, sent again because no transaction could begin.
    retry: Vec<Message>,
}

impl Settled {
    /// For messages that could not run because no transaction could begin.
    fn rejected(messages: impl Iterator<Item = Message>, error: &str) -> Settled {
        let mut settled = Settled::default();
        for message in messages {
            match message {
                Message::Write { reply: Some(reply), .. } => {
                    settled.write_replies.push((reply, Err(anyhow!("{error}"))))
                }
                Message::Run { reply, .. } => settled.run_replies.push((reply, Err(anyhow!("{error}")))),
                Message::Reload => settled.reload = true,
                Message::Stop => settled.stop = true,
                message => settled.retry.push(message),
            }
        }
        settled
    }
}

impl WriteLoop {
    pub fn new(shared: Arc<Shared>, conn: Connection) -> WriteLoop {
        WriteLoop { shared, conn, memory: RuleMemory::default() }
    }

    pub fn run(mut self, rx: Receiver<Message>) {
        loop {
            let Ok(first) = rx.recv() else { return };
            // Drained lazily, so messages that arrive while the batch runs still join it.
            let messages = std::iter::once(first).chain(rx.try_iter());
            let loaded = self.shared.loaded();
            if !self.conn.is_autocommit() {
                let _ = self.conn.execute_batch("ROLLBACK");
            }
            let (settled, committed) = match self.conn.execute_batch("BEGIN") {
                Ok(()) => {
                    let settled = self.process(&loaded, messages);
                    let committed = self.conn.execute_batch("COMMIT").map_err(|e| format!("commit failed: {e}"));
                    if committed.is_err() {
                        let _ = self.conn.execute_batch("ROLLBACK");
                        self.memory.fired_keys.clear();
                    }
                    (settled, committed)
                }
                Err(e) => {
                    let error = format!("cannot begin a transaction: {e}");
                    (Settled::rejected(messages, &error), Err(error))
                }
            };
            self.shared.batches_committed.fetch_add(1, SeqCst);
            if !settled.retry.is_empty() {
                for message in settled.retry {
                    let _ = self.shared.tx.send(message);
                }
                thread::sleep(BEGIN_RETRY_DELAY);
            }
            for (reply, result) in settled.write_replies {
                let _ = reply.send(committed.clone().map_err(anyhow::Error::msg).and(result));
            }
            for (reply, result) in settled.run_replies {
                let _ = reply.send(committed.clone().map_err(anyhow::Error::msg).and(result));
            }
            for rule in &settled.enabled_rules {
                self.memory.fired_keys.remove(rule);
            }
            let dirty = if committed.is_ok() { settled.dirty } else { DirtyTables::new() };
            let refreshes = self.shared.refreshes_after(&dirty, &settled.enabled_rules);
            self.shared.refresh(refreshes);

            let mut reload = settled.reload;
            for (id, args) in settled.restores {
                let restored = crate::maintenance::restore(&self.shared.home, &mut self.conn, &loaded, &args);
                let (state, summary) = match &restored {
                    Ok(path) => (ExitState::Success, format!("restored {}", path.display())),
                    Err(e) => (ExitState::Failure, format!("{e:#}")),
                };
                let _ = self.shared.tx.send(Message::RunExited { id, state, summary: Some(summary) });
                if restored.is_ok() {
                    self.memory.fired_keys.clear();
                    reload = true;
                }
            }
            if reload {
                self.shared.reload(&mut self.conn);
            }
            if settled.stop {
                return;
            }
        }
    }

    fn process(&mut self, loaded: &Loaded, messages: impl Iterator<Item = Message>) -> Settled {
        let mut settled = Settled::default();
        let mut batch = Batch {
            conn: &self.conn,
            loaded,
            shared: &self.shared,
            memory: &mut self.memory,
            dirty: DirtyTables::new(),
            events: Vec::new(),
        };
        let mut ticked = false;
        for message in messages {
            match message {
                Message::Write { name, params, origin, reply } => {
                    let result = batch.write(&name, &params, &origin);
                    if name == "core.rule_enable" && result.is_ok() {
                        settled.enabled_rules.extend(params["rule"].as_str().map(String::from));
                    }
                    settled.write_replies.extend(reply.map(|reply| (reply, result)));
                }
                Message::Run { command, args, origin, reply } => {
                    settled.run_replies.push((reply, batch.insert_manual_run(&command, &args, &origin)));
                }
                Message::Event(event) => batch.events.push(event),
                Message::Evaluate { rules, rows, caused_by } => {
                    for rule in rules {
                        if let Err(e) = batch.evaluate(&rule, &rows, &caused_by) {
                            batch.events.push(Event::error("engine", &rule, format!("{e:#}")));
                        }
                    }
                }
                Message::RunExited { id, state, summary } => {
                    self.shared.children.lock().unwrap().remove(&id);
                    let exit = json!({ "id": id, "state": state.as_str(), "summary": summary });
                    let _ = batch.core_write("run_exit", exit);
                }
                Message::Tick(now) => {
                    ticked = true;
                    if let Err(e) = batch.tick(now) {
                        batch.events.push(Event::error("engine", "tick", format!("{e:#}")));
                    }
                }
                Message::Reload => settled.reload = true,
                Message::Stop => settled.stop = true,
            }
        }
        if (ticked || batch.dirty.contains_key("core.runs"))
            && let Err(e) = batch.start_queued(&mut settled.restores)
        {
            batch.events.push(Event::error("engine", "runner", format!("{e:#}")));
        }
        batch.write_events();
        settled.dirty = batch.dirty;
        settled
    }
}

/// Unique as long as fewer than 4096 ids are made in one millisecond; ordered by time, then roughly by creation.
fn new_run_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("{:x}{:03x}", now_ms(), NEXT.fetch_add(1, SeqCst) % 4096)
}

fn render(template: &str, row: &Value) -> String {
    template_vars(template)
        .fold(template.to_string(), |out, var| out.replace(&format!("{{{var}}}"), &display_text(&row[var])))
}

/// Runs a writer's statements with its parameters; the caller provides the savepoint.
fn execute_writer(
    conn: &Connection,
    writer: &Writer,
    name: &str,
    params: &Value,
    run_id: Option<&str>,
) -> Result<usize> {
    reject_unknown_params(name, params, &writer.params)?;
    let mut changes = 0;
    for statement in &writer.statements {
        let values = bind(name, params, &statement.params, &writer.params, run_id)?;
        let mut prepared = conn.prepare_cached(&statement.sql)?;
        for (i, value) in values.iter().enumerate() {
            prepared.raw_bind_parameter(i + 1, value)?;
        }
        changes += prepared.raw_execute()?;
    }
    Ok(changes)
}

struct RuleState {
    enabled: bool,
    /// `None` until `core.rules_sync` has recorded the rule.
    last_evaluated: Option<i64>,
}

fn rule_state(conn: &Connection, rule: &str) -> Result<RuleState> {
    let state = conn
        .prepare_cached("SELECT enabled, last_evaluated FROM core.rules WHERE rule = ?1")?
        .query_row([rule], |r| Ok(RuleState { enabled: r.get(0)?, last_evaluated: r.get(1)? }))
        .optional()?;
    Ok(state.unwrap_or(RuleState { enabled: true, last_evaluated: None }))
}

#[derive(PartialEq, Eq)]
enum Fired {
    Continue,
    /// The rule hit its rate limit and was disabled: its remaining rows must not fire.
    RuleDisabled,
}

struct QueuedRun {
    id: String,
    command: String,
    args: String,
    rule: Option<String>,
}

/// One transaction's worth of messages.
struct Batch<'a> {
    conn: &'a Connection,
    loaded: &'a Loaded,
    shared: &'a Arc<Shared>,
    memory: &'a mut RuleMemory,
    dirty: DirtyTables,
    events: Vec<Event>,
}

impl Batch<'_> {
    /// Runs the writer in its own savepoint. Failures, and writes that changed rows, are recorded as events.
    fn write(&mut self, name: &str, params: &Value, origin: &Origin) -> Result<usize> {
        let Some(writer) = self.loaded.writers.get(name) else {
            let message = format!("no writer named {name}");
            self.events.push(Event {
                kind: EventKind::Error,
                name: name.into(),
                origin: origin.clone(),
                message: message.clone(),
            });
            bail!(message);
        };
        self.conn.execute_batch("SAVEPOINT w")?;
        let result = execute_writer(self.conn, writer, name, params, origin.run_id.as_deref());
        self.conn.execute_batch(if result.is_ok() { "RELEASE w" } else { "ROLLBACK TO w; RELEASE w" })?;
        match &result {
            Ok(0) => {}
            Ok(changes) => {
                for table in &writer.tables {
                    self.dirty.entry(table.clone()).or_default().extend(origin.run_id.clone());
                }
                let logged = !origin.is_engine() && writer.tables.iter().any(|t| t != "core.events");
                if logged {
                    let message = format!("{changes} changes");
                    self.events.push(Event {
                        kind: EventKind::Write,
                        name: name.into(),
                        origin: origin.clone(),
                        message,
                    });
                }
            }
            Err(e) => {
                let message = format!("{e:#}");
                self.events.push(Event { kind: EventKind::Error, name: name.into(), origin: origin.clone(), message });
            }
        }
        result
    }

    fn core_write(&mut self, writer: &str, params: Value) -> Result<usize> {
        self.write(&format!("core.{writer}"), &params, &Origin::engine())
    }

    fn insert_manual_run(&mut self, command: &str, args: &Value, origin: &Origin) -> Result<String> {
        let id = new_run_id();
        let run = json!({ "id": id, "command": command, "args": args.to_string(), "parent": origin.run_id, "depth": 0, "rule": null, "git_commit": self.loaded.commit });
        self.core_write("run_insert", run)?;
        Ok(id)
    }

    /// Fires the rule once for each row whose rendered key it has not fired before.
    fn evaluate(&mut self, rule_id: &str, rows: &Value, caused_by: &[String]) -> Result<()> {
        let loaded = self.loaded;
        let Some(rule) = loaded.rules.get(rule_id) else { return Ok(()) };
        let Some(watch) = &rule.watch else { return Ok(()) };
        if !rule_state(self.conn, rule_id)?.enabled {
            return Ok(());
        }
        self.memory.last_evaluated.insert(rule_id.to_string(), now_ms());
        let mut fired_keys = match self.memory.fired_keys.remove(rule_id) {
            Some(keys) => keys,
            None => self
                .conn
                .prepare_cached("SELECT key FROM core.firings WHERE rule = ?1")?
                .query_map([rule_id], |r| r.get(0))?
                .collect::<rusqlite::Result<HashSet<String>>>()?,
        };
        for row in rows.as_array().into_iter().flatten() {
            let key = render(&watch.key, row);
            if fired_keys.contains(&key) {
                continue;
            }
            fired_keys.insert(key.clone());
            if self.fire(rule, &key, row, caused_by)? == Fired::RuleDisabled {
                break;
            }
        }
        self.memory.fired_keys.insert(rule_id.to_string(), fired_keys);
        Ok(())
    }

    /// Records the firing, unless the key already fired, then applies the limits and starts the rule's action.
    fn fire(&mut self, rule: &Rule, key: &str, row: &Value, caused_by: &[String]) -> Result<Fired> {
        let commit = &self.loaded.commit;
        if self.core_write("firing", json!({ "rule": rule.id, "key": key, "git_commit": commit }))? == 0 {
            return Ok(Fired::Continue);
        }
        let (parent, parent_depth) = if caused_by.is_empty() {
            (None, 0)
        } else {
            self.conn
                .prepare_cached("SELECT id, depth FROM core.runs WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY depth DESC LIMIT 1")?
                .query_row([json!(caused_by).to_string()], |r| Ok((Some(r.get::<_, String>(0)?), r.get::<_, i64>(1)?)))
                .optional()?
                .unwrap_or((None, 0))
        };
        let depth = parent_depth + 1;
        let settings = &self.loaded.settings;
        let max_depth = i64::from(settings.max_depth);
        if depth > max_depth {
            let reason = format!("depth {depth} exceeds max_depth {max_depth}");
            self.core_write(
                "firing_update",
                json!({ "rule": rule.id, "key": key, "run_id": null, "blocked": reason }),
            )?;
            return Ok(Fired::Continue);
        }
        if rule.watch.is_some() {
            let max_per_hour = rule.max_per_hour.unwrap_or(settings.max_per_hour);
            let runs_last_hour: i64 = self
                .conn
                .prepare_cached("SELECT count(*) FROM core.firings WHERE rule = ?1 AND at > ?2 AND run_id IS NOT NULL")?
                .query_row(params![rule.id, now_ms() - HOUR_MS], |r| r.get(0))?;
            if runs_last_hour >= i64::from(max_per_hour) {
                let reason = format!("max_per_hour {max_per_hour} exceeded");
                self.core_write(
                    "firing_update",
                    json!({ "rule": rule.id, "key": key, "run_id": null, "blocked": reason }),
                )?;
                self.core_write("rule_disable", json!({ "rule": rule.id, "reason": reason }))?;
                return Ok(Fired::RuleDisabled);
            }
        }

        let args: Map<String, Value> = rule
            .args
            .iter()
            .map(|(name, value)| {
                let rendered = match value.as_str() {
                    Some(template) => {
                        let lone_column = template.strip_prefix('{').and_then(|t| t.strip_suffix('}'));
                        match lone_column.filter(|column| !column.contains(['{', '}'])) {
                            // A lone `{column}` keeps the column's JSON type.
                            Some(column) => row[column].clone(),
                            None => render(template, row).into(),
                        }
                    }
                    None => value.clone(),
                };
                (name.clone(), rendered)
            })
            .collect();
        let args = Value::Object(args);
        let trigger = format!("rule:{}", rule.id);
        let (command, inline_writer) = match &rule.action {
            Action::Write { writer } if rule.watch.is_none() => {
                // A schedule-only writer rule records only its firing, and its writes start a new lineage.
                let _ = self.write(writer, &args, &Origin { trigger, run_id: None });
                return Ok(Fired::Continue);
            }
            Action::Write { writer } => (writer, Some(writer)),
            Action::Run { command, .. } => (command, None),
        };
        let run_id = new_run_id();
        let run = json!({ "id": run_id, "command": command, "args": args.to_string(), "parent": parent, "depth": depth, "rule": rule.id, "git_commit": commit });
        self.core_write("run_insert", run)?;
        self.core_write("firing_update", json!({ "rule": rule.id, "key": key, "run_id": run_id, "blocked": null }))?;
        if let Some(writer) = inline_writer {
            let written = self.write(writer, &args, &Origin { trigger, run_id: Some(run_id.clone()) });
            self.core_write("run_start", json!({ "id": run_id, "pid": null }))?;
            let (state, summary) = match written {
                Ok(changes) => (ExitState::Success, format!("{writer}: {changes} changes")),
                Err(e) => (ExitState::Failure, format!("{e:#}")),
            };
            self.core_write("run_exit", json!({ "id": run_id, "state": state.as_str(), "summary": summary }))?;
        }
        Ok(Fired::Continue)
    }

    /// Starts queued runs, keeping at most `max_concurrency` rule runs running (`core.notify` is exempt).
    fn start_queued(&mut self, restores: &mut Vec<(String, Value)>) -> Result<()> {
        let max_concurrency = i64::from(self.loaded.settings.max_concurrency);
        let mut running: i64 = self.conn.query_row(
            "SELECT count(*) FROM core.runs WHERE state = 'running' AND rule IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        let queued: Vec<QueuedRun> = self
            .conn
            .prepare_cached(
                "SELECT id, command, args, rule FROM core.runs WHERE state = 'queued' ORDER BY created_at, rowid",
            )?
            .query_map([], |r| Ok(QueuedRun { id: r.get(0)?, command: r.get(1)?, args: r.get(2)?, rule: r.get(3)? }))?
            .collect::<rusqlite::Result<_>>()?;
        for QueuedRun { id, command, args, rule } in queued {
            let builtin = Builtin::parse(&command);
            if rule.is_some() && builtin != Some(Builtin::Notify) {
                if running >= max_concurrency {
                    continue;
                }
                running += 1;
            }
            let args: Value = serde_json::from_str(&args).unwrap_or(json!({}));
            let rule = rule.and_then(|r| self.loaded.rules.get(&r));
            let started = json!({ "id": id, "pid": null });
            match builtin {
                Some(Builtin::Notify) => {
                    self.core_write("run_start", started)?;
                    self.shared.emitter.emit("notify", json!({ "title": args["title"], "body": args["body"] }));
                    self.core_write(
                        "run_exit",
                        json!({ "id": id, "state": ExitState::Success.as_str(), "summary": null }),
                    )?;
                }
                Some(Builtin::Restore) => {
                    self.core_write("run_start", started)?;
                    self.shared.children.lock().unwrap().insert(id.clone(), Child::InEngine);
                    restores.push((id, args));
                }
                Some(Builtin::Snapshot) => {
                    self.core_write("run_start", started)?;
                    self.shared.children.lock().unwrap().insert(id.clone(), Child::InEngine);
                    let databases: Vec<(String, PathBuf)> = self
                        .loaded
                        .sources
                        .iter()
                        .filter_map(|(name, s)| Some((name.clone(), s.db.clone()?)))
                        .collect();
                    let (home, report) = (self.shared.home.clone(), ExitReport::new(self.shared, id));
                    thread::spawn(move || {
                        let only = args["source"].as_str();
                        let taken: Result<Vec<String>> = databases
                            .iter()
                            .filter(|(name, _)| only.is_none_or(|o| o == *name))
                            .map(|(name, db)| {
                                let path = crate::maintenance::snapshot(&home, name, db)?;
                                Ok(format!("{name}: {}", path.display()))
                            })
                            .collect();
                        let (state, summary) = match taken {
                            Ok(taken) => (ExitState::Success, taken.join("\n")),
                            Err(e) => (ExitState::Failure, format!("{e:#}")),
                        };
                        report.send(state, Some(summary));
                    });
                }
                None => {
                    let Some(path) = self.loaded.commands.get(&command) else {
                        self.core_write("run_start", started)?;
                        let summary = format!("no command named {command}");
                        self.core_write(
                            "run_exit",
                            json!({ "id": id, "state": ExitState::Failure.as_str(), "summary": summary }),
                        )?;
                        continue;
                    };
                    let (source, name) = command.split_once('.').unwrap_or((&command, ""));
                    let timeout = rule
                        .and_then(|r| r.timeout)
                        .or_else(|| self.loaded.sources.get(source).and_then(|s| s.config.timeouts.get(name).copied()))
                        .unwrap_or(self.loaded.settings.timeout);
                    let into = rule.and_then(|r| match &r.action {
                        Action::Run { into: Some(writer), .. } => {
                            Some(PayloadWriter { writer: writer.clone(), trigger: format!("rule:{}", r.id) })
                        }
                        _ => None,
                    });
                    let job = Job { id: id.clone(), path: path.clone(), args, timeout, into };
                    match crate::runner::spawn(self.shared, job) {
                        Ok(pid) => _ = self.core_write("run_start", json!({ "id": id, "pid": pid }))?,
                        Err(e) => {
                            self.core_write("run_start", started)?;
                            let summary = format!("cannot start: {e:#}");
                            self.core_write(
                                "run_exit",
                                json!({ "id": id, "state": ExitState::Failure.as_str(), "summary": summary }),
                            )?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// The minute tick: fires due schedules, expires and reaps runs, and trims what is past retention.
    fn tick(&mut self, now: i64) -> Result<()> {
        let local = chrono::DateTime::from_timestamp_millis(now).unwrap_or_default().with_timezone(&chrono::Local);
        let loaded = self.loaded;
        for rule in loaded.rules.values() {
            let Some(cron) = &rule.schedule else { continue };
            let state = rule_state(self.conn, &rule.id)?;
            if !state.enabled {
                continue;
            }
            self.core_write("rule_evaluated", json!({ "rule": rule.id, "at": now }))?;
            // Only the latest slot since the last evaluation fires, so a sleep fires a missed schedule once.
            let slot = cron.find_previous_occurrence(&local, true).ok();
            let Some(slot) = slot.filter(|s| state.last_evaluated.is_some_and(|last| s.timestamp_millis() > last))
            else {
                continue;
            };
            match &rule.watch {
                Some(watch) => {
                    let rows = query_rows(self.conn, &format!("SELECT * FROM \"{}\"", watch.view), &[])?.rows;
                    self.evaluate(&rule.id, &rows, &[])?;
                }
                None => _ = self.fire(rule, &format!("slot:{}", slot.format("%Y-%m-%dT%H:%M")), &Value::Null, &[])?,
            }
        }
        for (rule, at) in std::mem::take(&mut self.memory.last_evaluated) {
            self.core_write("rule_evaluated", json!({ "rule": rule, "at": at }))?;
        }

        let settings = &loaded.settings;
        self.core_write("run_expire", json!({ "before": now.saturating_sub(millis(settings.open_run_expiry)) }))?;
        let running: Vec<(String, Option<i64>)> = self
            .conn
            .prepare_cached("SELECT id, pid FROM core.runs WHERE state = 'running'")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let lost: Vec<String> = {
            let children = self.shared.children.lock().unwrap();
            running
                .into_iter()
                .filter(|(id, pid)| {
                    let alive = pid.and_then(|p| u32::try_from(p).ok()).is_some_and(crate::process_exists);
                    !children.contains_key(id) && !alive
                })
                .map(|(id, _)| id)
                .collect()
        };
        for id in lost {
            self.core_write("run_lost", json!({ "id": id, "summary": "process gone" }))?;
        }

        let before = now.saturating_sub(millis(settings.retention));
        let trimmed: Vec<String> = self
            .conn
            .prepare_cached("SELECT id FROM core.runs WHERE coalesce(finished_at, created_at) < ?1 AND state NOT IN ('queued', 'running', 'open')")?
            .query_map([before], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in trimmed {
            let _ = fs::remove_file(self.shared.home.join(format!("data/logs/{id}.log")));
        }
        self.core_write("trim", json!({ "before": before, "slots_before": now - SLOT_FIRING_RETENTION_MS }))?;
        // With only the core source loaded, every other database would look orphaned.
        if self.shared.folder_loaded.load(SeqCst) {
            crate::maintenance::trash_orphaned_databases(&self.shared.home, loaded, now);
        }
        Ok(())
    }

    /// Writes the batch's events through `core.event`, which records no events of its own.
    fn write_events(&mut self) {
        if self.events.is_empty() {
            return;
        }
        let Some(writer) = self.loaded.writers.get("core.event") else { return };
        for event in std::mem::take(&mut self.events) {
            let params = json!({ "kind": event.kind.as_str(), "name": event.name, "trigger": event.origin.trigger, "message": event.message, "git_commit": self.loaded.commit });
            let _ = execute_writer(self.conn, writer, "core.event", &params, event.origin.run_id.as_deref());
        }
        self.dirty.entry("core.events".into()).or_default();
    }
}
