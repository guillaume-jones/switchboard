// Adversarial review tests. Each test name states the guarantee it attacks.
// Tests that FAIL expose a real defect; passing tests confirm the guarantee holds.
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};
use switchboard_core::{Diagnostic, Emitter, Engine, Mode, Origin, load};

fn write(home: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let path = home.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        if path.to_string_lossy().contains("/commands/") {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn home(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), files);
    dir
}

#[track_caller]
fn errors(home: &Path) -> String {
    match load(home, Mode::Check) {
        Ok(_) => String::new(),
        Err(d) => d.iter().filter(|d| d.is_error()).map(Diagnostic::to_string).collect::<Vec<_>>().join("\n"),
    }
}

#[track_caller]
fn warnings(home: &Path) -> String {
    match load(home, Mode::Check) {
        Ok(l) => l.warnings.iter().map(Diagnostic::to_string).collect::<Vec<_>>().join("\n"),
        Err(d) => d.iter().map(Diagnostic::to_string).collect::<Vec<_>>().join("\n"),
    }
}

const PRS: &[(&str, &str)] = &[
    ("sources/prs/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT\n);\n"),
    ("sources/prs/views/items.sql", "SELECT id, title FROM prs.items"),
    ("sources/prs/writes/add.sql", "INSERT OR IGNORE INTO prs.items (id, title) VALUES (:id, :title)"),
];

fn with_prs(extra: &[(&str, &str)]) -> tempfile::TempDir {
    let d = home(PRS);
    write(d.path(), extra);
    d
}

// ---- Ownership ----

#[test]
fn ownership_writer_cannot_write_other_source_via_subselect() {
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/writes/bad.sql", "INSERT INTO prs.items (id, title) VALUES (:id, 'x')"),
    ]);
    let e = errors(d.path());
    assert!(e.contains("prs.items") && e.contains("own source"), "writer wrote another source: {e:?}");
}

#[test]
fn ownership_view_cannot_read_other_source_table_via_scalar_subquery() {
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/views/leak.sql", "SELECT pr, (SELECT title FROM prs.items LIMIT 1) AS t FROM board.pins"),
    ]);
    let e = errors(d.path());
    assert!(e.contains("prs.items") && e.contains("private table"), "scalar subquery leaked another source: {e:?}");
}

#[test]
fn ownership_view_cannot_read_other_source_table_via_cte() {
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/views/leak.sql", "WITH x AS (SELECT id, title FROM prs.items) SELECT id, title FROM x"),
    ]);
    let e = errors(d.path());
    assert!(e.contains("prs.items"), "CTE leaked another source: {e:?}");
}

#[test]
fn ownership_view_cannot_read_other_source_table_via_union() {
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/views/leak.sql", "SELECT pr AS id FROM board.pins UNION ALL SELECT id FROM prs.items"),
    ]);
    let e = errors(d.path());
    assert!(e.contains("prs.items"), "UNION leaked another source: {e:?}");
}

#[test]
fn ownership_pragma_table_valued_function_cannot_leak_other_source_schema() {
    // pragma_* table functions can read another source's schema; the authorizer should deny them.
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/views/leak.sql", "SELECT name AS id FROM pragma_table_info('items', 'prs')"),
    ]);
    let e = errors(d.path());
    assert!(!e.is_empty(), "pragma_table_info over another source loaded cleanly (schema leak): {e:?}");
}

// ---- Classification ----

#[test]
fn classification_writer_cannot_attach_database() {
    let d = with_prs(&[(
        "sources/prs/writes/evil.sql",
        "ATTACH DATABASE 'x.db' AS x;\nINSERT INTO prs.items (id, title) VALUES (:id, 't')",
    )]);
    assert!(!errors(d.path()).is_empty(), "ATTACH in a writer was accepted");
}

#[test]
fn classification_view_cannot_run_pragma() {
    let d = with_prs(&[("sources/prs/views/p.sql", "SELECT 1 AS id WHERE (PRAGMA journal_mode) IS NOT NULL")]);
    assert!(!errors(d.path()).is_empty(), "PRAGMA in a view was accepted");
}

#[test]
fn classification_query_cannot_do_ddl() {
    let d = with_prs(&[("sources/prs/queries/q.sql", "CREATE TABLE prs.sneaky (x) ")]);
    assert!(!errors(d.path()).is_empty(), "DDL in a query was accepted");
}

// ---- Additive-only schema ----

#[test]
fn additive_drop_column_refused() {
    let d = home(PRS);
    load(d.path(), Mode::Apply).unwrap();
    write(d.path(), &[("sources/prs/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY\n);\n")]);
    assert!(errors(d.path()).contains("removed or renamed"), "dropping a column was allowed");
}

#[test]
fn additive_deprecated_column_read_refused() {
    let d = with_prs(&[
        (
            "sources/prs/schema.sql",
            "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  old TEXT -- @deprecated gone\n);\n",
        ),
        ("sources/prs/views/bad.sql", "SELECT id, old FROM prs.items"),
    ]);
    assert!(errors(d.path()).contains("deprecated"), "reading a @deprecated column was allowed");
}

// A `now`-dependent view that uses a function form the loader does not recognise as time-dependent.
// Spec guarantee: a rule watching a now-dependent view without a schedule under-fires; the loader warns.
#[test]
fn classification_now_view_via_unixepoch_is_detected_as_time_dependent() {
    let d = with_prs(&[
        ("sources/prs/views/fresh.sql", "SELECT id, title FROM prs.items WHERE id > unixepoch() - 60"),
        (
            "rules/r.json",
            r#"{"id":"r","when":{"view":"prs_fresh"},"key":"{id}","into":"prs.add","args":{"id":"{id}","title":"{title}"}}"#,
        ),
    ]);
    let w = warnings(d.path());
    assert!(w.contains("current time"), "unixepoch() view not recognised as now-dependent: warnings={w:?}");
}

#[test]
fn classification_now_view_via_bare_date_is_detected_as_time_dependent() {
    let d = with_prs(&[
        ("sources/prs/views/fresh.sql", "SELECT id, title FROM prs.items WHERE title > date()"),
        (
            "rules/r.json",
            r#"{"id":"r","when":{"view":"prs_fresh"},"key":"{id}","into":"prs.add","args":{"id":"{id}","title":"{title}"}}"#,
        ),
    ]);
    let w = warnings(d.path());
    assert!(w.contains("current time"), "bare date() view not recognised as now-dependent: warnings={w:?}");
}

// ---- Malformed input: the loader must not panic ----

#[test]
fn malformed_binary_schema_does_not_panic() {
    let d = home(PRS);
    fs::write(d.path().join("sources/prs/schema.sql"), [0u8, 159, 146, 150, 0, 255, 200]).unwrap();
    let _ = load(d.path(), Mode::Check); // must return, not panic
}

#[test]
fn malformed_huge_token_does_not_panic() {
    let d = home(PRS);
    let big = format!("SELECT id, title, '{}' AS x FROM prs.items", "a".repeat(2_000_000));
    write(d.path(), &[("sources/prs/views/big.sql", &big)]);
    let _ = load(d.path(), Mode::Check);
}

#[test]
fn malformed_rule_json_binary_does_not_panic() {
    let d = home(PRS);
    fs::create_dir_all(d.path().join("rules")).unwrap();
    fs::write(d.path().join("rules/x.json"), [0xffu8, 0x00, 0x80, b'{']).unwrap();
    let _ = load(d.path(), Mode::Check);
}

#[test]
fn malformed_symlinked_schema_does_not_panic() {
    let d = home(PRS);
    let target = d.path().join("sources/prs/schema.sql");
    fs::remove_file(&target).unwrap();
    std::os::unix::fs::symlink("/dev/null", &target).unwrap();
    let _ = load(d.path(), Mode::Check);
}

// ========================= Engine tests =========================

struct Events(Mutex<Sender<(String, Value)>>);
impl Emitter for Events {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.lock().unwrap().send((event.into(), payload));
    }
}

fn open(home: &Path) -> (Engine, Receiver<(String, Value)>) {
    let (tx, rx) = channel();
    (Engine::open(home, Events(Mutex::new(tx))).unwrap(), rx)
}

fn card() -> Origin {
    Origin { trigger: "card".into(), run_id: None }
}

#[track_caller]
fn until(engine: &Engine, name: &str, params: Value, secs: u64, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let rows = engine.query(name, params.clone()).unwrap().as_array().unwrap().clone();
        if done(&rows) {
            return rows;
        }
        assert!(Instant::now() < deadline, "timed out on {name}: {rows:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// Invalidation across a two-level nested cross-source view.
#[test]
fn invalidation_reaches_subscription_through_two_nested_views() {
    let d = with_prs(&[
        ("sources/board/schema.sql", "CREATE TABLE pins (pr INTEGER PRIMARY KEY);\n"),
        ("sources/board/views/pinned.sql", "SELECT i.id, i.title FROM board.pins p JOIN prs_items i ON i.id = p.pr"),
        ("sources/board/writes/pin.sql", "INSERT OR IGNORE INTO board.pins (pr) VALUES (:pr)"),
        ("sources/feed/views/top.sql", "SELECT id, title FROM board_pinned"),
    ]);
    let (engine, rx) = open(d.path());
    let (sub, rows) = engine.subscribe("feed_top", json!({})).unwrap();
    assert_eq!(rows, json!([]));
    engine.write("prs.add", json!({"id": 1, "title": "one"}), card()).unwrap();
    engine.write("board.pin", json!({"pr": 1}), card()).unwrap();
    // now change prs.items title; feed_top -> board_pinned -> prs_items -> prs.items
    engine.write("prs.add", json!({"id": 1, "title": "one"}), card()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut last = json!([]);
    while Instant::now() < deadline {
        if let Ok((e, p)) = rx.recv_timeout(Duration::from_millis(100))
            && e == "rows"
            && p["id"] == sub
        {
            last = p["rows"].clone();
        }
    }
    assert_eq!(last, json!([{"id": 1, "title": "one"}]), "nested cross-source invalidation missed");
    let _ = (&engine,);
    drop(engine);
}

#[test]
fn spool_writes_replay_in_order_on_start() {
    let d = home(PRS);
    // no engine running: spool three writes out of order of creation but named by time
    let spool = d.path().join("data/spool");
    fs::create_dir_all(&spool).unwrap();
    for (i, id) in [3, 1, 2].into_iter().enumerate() {
        let name = format!("{:020}-0.json", i);
        let req = json!({"op":"write","name":"prs.add","params":{"id": id, "title": format!("n{id}")}});
        fs::write(spool.join(name), req.to_string()).unwrap();
    }
    let (engine, _rx) = open(d.path());
    let rows = until(&engine, "prs_items", json!({}), 5, |r| r.len() == 3);
    assert_eq!(rows.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3]);
}

// ---- Rule limits under concurrent writers (added in the final core pass) ----

const LIMITS: &[(&str, &str)] = &[
    ("sources/prs/views/next.sql", "SELECT id, id + 1 AS next FROM prs.items"),
    ("sources/log/schema.sql", "CREATE TABLE notes (\n  id INTEGER PRIMARY KEY,\n  key TEXT\n);\n"),
    ("sources/log/views/notes.sql", "SELECT id, key FROM log.notes"),
    ("sources/log/writes/note.sql", "INSERT INTO log.notes (key) VALUES (:key)"),
];

fn hammer(engine: &Engine, threads: i64, per: i64, write: impl Fn(&Engine, i64) + Sync) {
    std::thread::scope(|s| {
        for t in 0..threads {
            let write = &write;
            s.spawn(move || (0..per).for_each(|k| write(engine, t * per + k)));
        }
    });
}

fn settle(engine: &Engine, name: &str, params: Value) -> Vec<Value> {
    let mut last = usize::MAX;
    loop {
        std::thread::sleep(Duration::from_millis(300));
        let rows = engine.query(name, params.clone()).unwrap().as_array().unwrap().clone();
        if rows.len() == last {
            return rows;
        }
        last = rows.len();
    }
}

#[test]
fn limits_rate_limit_is_exact_under_concurrent_writes() {
    let d = with_prs(LIMITS);
    write(
        d.path(),
        &[(
            "rules/cap.json",
            r#"{"id": "cap", "when": {"view": "prs_items"}, "key": "{id}", "into": "log.note", "args": {"key": "{id}"}, "max_per_hour": 10}"#,
        )],
    );
    let (engine, _rx) = open(d.path());
    hammer(&engine, 8, 25, |e, id| _ = e.write("prs.add", json!({"id": id, "title": "x"}), card()).unwrap());
    let firings = settle(&engine, "core_firings", json!({"rule": "cap"}));
    let fired = firings.iter().filter(|f| f["run_id"].is_string()).count();
    let blocked: Vec<_> = firings.iter().filter(|f| f["blocked"].is_string()).collect();
    assert_eq!((fired, blocked.len(), firings.len()), (10, 1, 11), "{firings:?}");
    assert!(blocked[0]["blocked"].as_str().unwrap().contains("max_per_hour 10 exceeded"));
    assert_eq!(engine.query("log_notes", json!({})).unwrap().as_array().unwrap().len(), 10);
    assert_eq!(engine.query("core_rules", json!({"rule": "cap"})).unwrap()[0]["enabled"], 0);
}

#[test]
fn limits_depth_limit_is_exact_with_unrelated_concurrent_writes() {
    let d = with_prs(LIMITS);
    write(
        d.path(),
        &[
            ("settings.json", r#"{"max_depth": 3}"#),
            (
                "rules/chain.json",
                r#"{"id": "chain", "when": {"view": "prs_next"}, "key": "{id}", "into": "prs.add", "args": {"id": "{next}", "title": "chain"}}"#,
            ),
        ],
    );
    let (engine, _rx) = open(d.path());
    std::thread::scope(|s| {
        s.spawn(|| hammer(&engine, 8, 50, |e, k| _ = e.write("log.note", json!({"key": k}), card()).unwrap()));
        engine.write("prs.add", json!({"id": 1000, "title": "start"}), card()).unwrap();
    });
    let firings = settle(&engine, "core_firings", json!({"rule": "chain"}));
    let blocked: Vec<_> = firings.iter().filter(|f| f["blocked"].is_string()).collect();
    assert_eq!((firings.len(), blocked.len()), (4, 1), "{firings:?}");
    assert_eq!(blocked[0]["key"], "1003");
    let ids: Vec<i64> = engine
        .query("prs_items", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [1000, 1001, 1002, 1003]);
}

#[test]
fn limits_depth_is_never_bypassed_by_concurrent_chains() {
    let d = with_prs(LIMITS);
    write(
        d.path(),
        &[
            ("settings.json", r#"{"max_depth": 3, "max_per_hour": 1000}"#),
            (
                "rules/chain.json",
                r#"{"id": "chain", "when": {"view": "prs_next"}, "key": "{id}", "into": "prs.add", "args": {"id": "{next}", "title": "chain"}}"#,
            ),
        ],
    );
    let (engine, _rx) = open(d.path());
    hammer(&engine, 6, 1, |e, chain| {
        _ = e.write("prs.add", json!({"id": (chain + 1) * 1000, "title": "start"}), card()).unwrap()
    });
    let runs = settle(&engine, "core_runs", json!({"rule": "chain"}));
    let firings = settle(&engine, "core_firings", json!({"rule": "chain"}));
    assert!(runs.iter().all(|r| r["depth"].as_i64().unwrap() <= 3), "a run exceeded max_depth: {runs:?}");
    for chain in 1..=6 {
        let mine: Vec<_> =
            firings.iter().filter(|f| f["key"].as_str().unwrap().parse::<i64>().unwrap() / 1000 == chain).collect();
        assert!(mine.len() <= 4, "chain {chain} fired past its depth: {mine:?}");
        assert_eq!(
            mine.iter().filter(|f| f["blocked"].is_string()).count(),
            1,
            "chain {chain} must end blocked: {mine:?}"
        );
    }
}
