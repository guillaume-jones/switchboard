//! Active reads: views and queries subscribed by cards or watched by rules, re-run after the commits that touch
//! their tables, and pushed only when their result changes.

use super::{Access, Event, EventKind, Message, Origin, Shared, connect};
use crate::loader::Loaded;
use anyhow::{Context, Result, anyhow, bail};
use rusqlite::Connection;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{Map, Value};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::thread;
use std::time::{Duration, Instant};

/// Reader threads (and connections) used to re-run active reads after a commit.
const REFRESH_READERS: usize = 4;
const SLOW_READ: Duration = Duration::from_millis(100);

/// Tables written in a batch → the runs that wrote them.
pub(super) type DirtyTables = BTreeMap<String, BTreeSet<String>>;

/// A view or query with its parameters bound, and the tables whose writes invalidate its result.
pub(super) struct ResolvedRead {
    sql: String,
    binds: Vec<SqlValue>,
    tables: BTreeSet<String>,
    /// Set once a slow run is reported, until a run is fast again.
    reported_slow: AtomicBool,
}

pub(super) struct ReadResult {
    pub rows: Value,
    pub hash: u64,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) struct ReadKey {
    name: String,
    /// The params as JSON, whose object keys are sorted, so equal params have equal text.
    params: String,
}

impl ReadKey {
    fn new(name: &str, params: &Value) -> ReadKey {
        ReadKey { name: name.into(), params: params.to_string() }
    }
}

struct ActiveRead {
    name: String,
    params: Value,
    /// `None` once a reload removed what it reads, until a later reload brings it back.
    read: Option<Arc<ResolvedRead>>,
    last_hash: Option<u64>,
    subscribers: Vec<u64>,
    watching_rules: Vec<String>,
}

impl ActiveRead {
    fn new(name: &str, params: Value, read: Arc<ResolvedRead>) -> ActiveRead {
        ActiveRead {
            name: name.into(),
            params,
            read: Some(read),
            last_hash: None,
            subscribers: Vec::new(),
            watching_rules: Vec::new(),
        }
    }

    fn is_used(&self) -> bool {
        !self.subscribers.is_empty() || !self.watching_rules.is_empty()
    }
}

/// Identical subscriptions share one active read.
#[derive(Default)]
pub(super) struct Subscriptions {
    last_id: u64,
    reads: HashMap<ReadKey, ActiveRead>,
    keys_by_id: HashMap<u64, ReadKey>,
}

/// Idle read-only connections, discarded when a reload changes what they attach.
#[derive(Default)]
pub(super) struct ReaderPool {
    generation: u64,
    idle: Vec<Connection>,
}

impl ReaderPool {
    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.idle.clear();
    }
}

pub(super) struct Refresh {
    key: ReadKey,
    /// Runs whose writes dirtied the read, which become the parents of the runs its rules start.
    caused_by: Vec<String>,
    /// Evaluates the watching rules even when the result did not change.
    force_rules: bool,
}

fn to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            n.as_i64().map_or_else(|| SqlValue::Real(n.as_f64().unwrap_or_default()), SqlValue::Integer)
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        v => SqlValue::Text(v.to_string()),
    }
}

fn expected(params: &[String]) -> String {
    params.iter().map(|p| format!(":{p}")).collect::<Vec<_>>().join(", ")
}

pub(super) fn reject_unknown_params(name: &str, params: &Value, allowed: &[String]) -> Result<()> {
    if !params.is_object() && !params.is_null() {
        bail!("{name}: params must be a JSON object");
    }
    if let Some(unknown) = params.as_object().into_iter().flat_map(Map::keys).find(|k| !allowed.contains(k)) {
        bail!("{name}: unknown param :{unknown} (expects {})", expected(allowed));
    }
    Ok(())
}

/// The values of `wanted`, in order. `:run_id` defaults to the calling run.
pub(super) fn bind(
    name: &str,
    params: &Value,
    wanted: &[String],
    allowed: &[String],
    run_id: Option<&str>,
) -> Result<Vec<SqlValue>> {
    wanted
        .iter()
        .map(|param| match (params.get(param), param.as_str()) {
            (Some(value), _) => Ok(to_sql(value)),
            (None, "run_id") => Ok(run_id.map_or(SqlValue::Null, |r| SqlValue::Text(r.into()))),
            (None, _) => Err(anyhow!("{name}: missing param :{param} (expects {})", expected(allowed))),
        })
        .collect()
}

/// A view filtered by column equality, or a query with its parameters.
fn resolve(loaded: &Loaded, name: &str, params: &Value) -> Result<ResolvedRead> {
    if let Some(view) = loaded.views.get(name) {
        reject_unknown_params(name, params, &view.columns)?;
        let mut sql = format!("SELECT * FROM \"{name}\"");
        let mut binds = Vec::new();
        for (i, (column, value)) in params.as_object().into_iter().flatten().enumerate() {
            let integer = value
                .as_i64()
                .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok().filter(|n| n.to_string() == s)));
            // An untyped column keeps whatever storage class was written, so an id given as "5" or 5 matches both.
            let test = match integer.filter(|_| view.untyped_columns.contains(column)) {
                Some(n) => {
                    binds.extend([SqlValue::Integer(n), SqlValue::Text(n.to_string())]);
                    "IN (?, ?)"
                }
                None => {
                    binds.push(to_sql(value));
                    "IS ?"
                }
            };
            let _ = write!(sql, " {} \"{column}\" {test}", if i == 0 { "WHERE" } else { "AND" });
        }
        return Ok(ResolvedRead { sql, binds, tables: view.tables.clone(), reported_slow: AtomicBool::new(false) });
    }
    let Some(query) = loaded.queries.get(name) else {
        let hint = if loaded.writers.contains_key(name) { " (it is a writer; call write)" } else { "" };
        bail!("no view or query named {name}{hint}");
    };
    reject_unknown_params(name, params, &query.params)?;
    let binds = bind(name, params, &query.params, &query.params, None)?;
    Ok(ResolvedRead {
        sql: query.sql.clone(),
        binds,
        tables: query.tables.clone(),
        reported_slow: AtomicBool::new(false),
    })
}

/// The rows as JSON objects, and a hash of the column names and values.
pub(super) fn query_rows(conn: &Connection, sql: &str, binds: &[SqlValue]) -> rusqlite::Result<ReadResult> {
    let mut statement = conn.prepare_cached(sql)?;
    let names: Vec<String> = statement.column_names().map(String::from).collect();
    let mut hasher = DefaultHasher::new();
    names.hash(&mut hasher);
    let mut rows = statement.query(rusqlite::params_from_iter(binds))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => {
                    0u8.hash(&mut hasher);
                    Value::Null
                }
                ValueRef::Integer(n) => {
                    (1u8, n).hash(&mut hasher);
                    n.into()
                }
                ValueRef::Real(x) => {
                    (2u8, x.to_bits()).hash(&mut hasher);
                    x.into()
                }
                ValueRef::Text(t) => {
                    (3u8, t).hash(&mut hasher);
                    String::from_utf8_lossy(t).into()
                }
                ValueRef::Blob(b) => {
                    (4u8, b).hash(&mut hasher);
                    b.into()
                }
            };
            object.insert(name.clone(), value);
        }
        out.push(Value::Object(object));
    }
    Ok(ReadResult { rows: Value::Array(out), hash: hasher.finish() })
}

impl Shared {
    fn with_reader<T>(&self, f: impl FnOnce(&Connection) -> T) -> Result<T> {
        let (generation, idle) = {
            let mut pool = self.readers.lock().unwrap();
            (pool.generation, pool.idle.pop())
        };
        let conn = match idle {
            Some(conn) => conn,
            None => connect(&self.loaded(), Access::ReadOnly)?,
        };
        let out = f(&conn);
        let mut pool = self.readers.lock().unwrap();
        if pool.generation == generation {
            pool.idle.push(conn);
        }
        Ok(out)
    }

    /// Runs the read, recording errors and slow reads as events.
    fn timed_read(&self, conn: &Connection, name: &str, read: &ResolvedRead) -> Result<ReadResult> {
        let start = Instant::now();
        let result = query_rows(conn, &read.sql, &read.binds).with_context(|| name.to_string());
        let elapsed = start.elapsed();
        // Once per slow streak: the event dirties core.events, which re-runs this read if it reads core.events.
        if elapsed <= SLOW_READ {
            read.reported_slow.store(false, SeqCst);
        } else if !read.reported_slow.swap(true, SeqCst) {
            let message = format!("{} ms", elapsed.as_millis());
            self.record(Event { kind: EventKind::SlowRead, name: name.into(), origin: Origin::engine(), message });
        }
        // Recording an error would dirty core.events and re-run this read, forever.
        if read.tables.contains("core.events") {
            return result;
        }
        if let Err(e) = &result {
            self.record(Event::error("sql", name, format!("{e:#}")));
        }
        result
    }

    /// Re-runs the reads, pushes changed results to their subscribers and sends them to their rules.
    pub(super) fn refresh(&self, refreshes: Vec<Refresh>) {
        let jobs: Vec<(Refresh, String, Arc<ResolvedRead>)> = {
            let subscriptions = self.subscriptions.lock().unwrap();
            refreshes
                .into_iter()
                .filter_map(|r| {
                    let active = subscriptions.reads.get(&r.key)?;
                    let read = active.read.clone()?;
                    Some((r, active.name.clone(), read))
                })
                .collect()
        };
        let workers = jobs.len().min(REFRESH_READERS);
        let work = |worker: usize| {
            let done = self.with_reader(|conn| {
                for (refresh, name, read) in jobs.iter().skip(worker).step_by(workers) {
                    let Ok(ReadResult { mut rows, hash }) = self.timed_read(conn, name, read) else { continue };
                    let (subscribers, rules) = match self.subscriptions.lock().unwrap().reads.get_mut(&refresh.key) {
                        Some(active) if active.last_hash != Some(hash) => {
                            active.last_hash = Some(hash);
                            (active.subscribers.clone(), active.watching_rules.clone())
                        }
                        Some(active) if refresh.force_rules => (Vec::new(), active.watching_rules.clone()),
                        _ => continue,
                    };
                    let mut consumers = subscribers.len() + usize::from(!rules.is_empty());
                    let mut next_rows = || {
                        consumers -= 1;
                        if consumers == 0 { std::mem::take(&mut rows) } else { rows.clone() }
                    };
                    if !rules.is_empty() {
                        let caused_by = refresh.caused_by.clone();
                        let _ = self.tx.send(Message::Evaluate { rules, rows: next_rows(), caused_by });
                    }
                    for id in subscribers {
                        let payload = Map::from_iter([("id".into(), Value::from(id)), ("rows".into(), next_rows())]);
                        self.emitter.emit("rows", Value::Object(payload));
                    }
                }
            });
            if let Err(e) = done {
                self.record(Event::error("engine", "reader", format!("{e:#}")));
            }
        };
        match workers {
            0 => {}
            1 => work(0),
            _ => thread::scope(|scope| {
                for worker in 0..workers {
                    let work = &work;
                    scope.spawn(move || work(worker));
                }
            }),
        }
    }

    /// The reads to re-run after a batch: those reading a dirty table, and those watched by a re-enabled rule.
    pub(super) fn refreshes_after(&self, dirty: &DirtyTables, enabled_rules: &[String]) -> Vec<Refresh> {
        let subscriptions = self.subscriptions.lock().unwrap();
        subscriptions
            .reads
            .iter()
            .filter_map(|(key, active)| {
                let tables = &active.read.as_ref()?.tables;
                let dirtied = tables.iter().any(|t| dirty.contains_key(t));
                let force_rules = active.watching_rules.iter().any(|r| enabled_rules.contains(r));
                (dirtied || force_rules).then(|| {
                    let caused_by: BTreeSet<&String> = tables.iter().filter_map(|t| dirty.get(t)).flatten().collect();
                    Refresh { key: key.clone(), caused_by: caused_by.into_iter().cloned().collect(), force_rules }
                })
            })
            .collect()
    }

    /// Points every rule's view at an active read, which is evaluated even if its result has not changed.
    pub(super) fn watch_rule_views(&self, loaded: &Loaded) -> Vec<Refresh> {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        for active in subscriptions.reads.values_mut() {
            active.watching_rules.clear();
        }
        let mut keys = BTreeSet::new();
        let no_params = Value::Object(Map::new());
        for rule in loaded.rules.values() {
            let Some(watch) = &rule.watch else { continue };
            let key = ReadKey::new(&watch.view, &no_params);
            let active = match subscriptions.reads.entry(key.clone()) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(entry) => {
                    let Ok(read) = resolve(loaded, &watch.view, &no_params) else { continue };
                    entry.insert(ActiveRead::new(&watch.view, no_params.clone(), Arc::new(read)))
                }
            };
            active.watching_rules.push(rule.id.clone());
            keys.insert(key);
        }
        subscriptions.reads.retain(|_, active| active.is_used());
        keys.into_iter().map(|key| Refresh { key, caused_by: Vec::new(), force_rules: true }).collect()
    }

    /// Re-resolves every active read against a new load, to be re-run on the new connections.
    pub(super) fn resolve_reads_again(&self, loaded: &Loaded) -> Vec<Refresh> {
        let mut refreshes = Vec::new();
        for (key, active) in self.subscriptions.lock().unwrap().reads.iter_mut() {
            match resolve(loaded, &active.name, &active.params) {
                Ok(read) => {
                    active.read = Some(Arc::new(read));
                    refreshes.push(Refresh { key: key.clone(), caused_by: Vec::new(), force_rules: false });
                }
                Err(e) => {
                    active.read = None;
                    self.record(Event::error("loader", &active.name, format!("{e:#}")));
                }
            }
        }
        refreshes
    }

    pub(super) fn subscribe(&self, name: &str, params: Value) -> Result<(u64, Value)> {
        let loaded = self.loaded();
        let read = resolve(&loaded, name, &params)
            .inspect_err(|e| self.record(Event::error("subscribe", name, format!("{e:#}"))))?;
        let read = Arc::new(read);
        let key = ReadKey::new(name, &params);
        let (id, created) = {
            let mut subscriptions = self.subscriptions.lock().unwrap();
            subscriptions.last_id += 1;
            let id = subscriptions.last_id;
            subscriptions.keys_by_id.insert(id, key.clone());
            let created = !subscriptions.reads.contains_key(&key);
            let active =
                subscriptions.reads.entry(key.clone()).or_insert_with(|| ActiveRead::new(name, params, read.clone()));
            active.subscribers.push(id);
            (id, created)
        };
        // Retried until no batch committed during the read, so the result is not older than a push it raced.
        loop {
            let batches_before = self.batches_committed.load(SeqCst);
            let result = match self.with_reader(|conn| self.timed_read(conn, name, &read)).and_then(|r| r) {
                Ok(result) => result,
                Err(e) => {
                    self.unsubscribe(id);
                    return Err(e);
                }
            };
            if created && let Some(active) = self.subscriptions.lock().unwrap().reads.get_mut(&key) {
                active.last_hash = Some(result.hash);
            }
            if self.batches_committed.load(SeqCst) == batches_before {
                return Ok((id, result.rows));
            }
        }
    }

    pub(super) fn unsubscribe(&self, id: u64) {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        let Some(key) = subscriptions.keys_by_id.remove(&id) else { return };
        if let Some(active) = subscriptions.reads.get_mut(&key) {
            active.subscribers.retain(|s| *s != id);
            if !active.is_used() {
                subscriptions.reads.remove(&key);
            }
        }
    }

    pub(crate) fn query(&self, name: &str, params: Value) -> Result<Value> {
        let loaded = self.loaded();
        let read = resolve(&loaded, name, &params)
            .inspect_err(|e| self.record(Event::error("query", name, format!("{e:#}"))))?;
        Ok(self.with_reader(|conn| self.timed_read(conn, name, &read))??.rows)
    }
}
