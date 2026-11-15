use switchboard_core::{Emitter, Engine, Origin, SystemEvent};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

struct Events(Mutex<Sender<(String, Value)>>);

impl Emitter for Events {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.lock().unwrap().send((event.into(), payload));
    }
}

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

const BASE: &[(&str, &str)] = &[
    ("sources/prs/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT\n);\n"),
    ("sources/prs/views/items.sql", "SELECT id, title FROM prs.items"),
    ("sources/prs/views/next.sql", "SELECT id, id + 1 AS next FROM prs.items"),
    ("sources/prs/writes/add.sql", "INSERT OR IGNORE INTO prs.items (id, title) VALUES (:id, 'item ' || :id)"),
    ("sources/log/schema.sql", "CREATE TABLE notes (\n  id INTEGER PRIMARY KEY,\n  key TEXT,\n  run_id TEXT\n);\n"),
    ("sources/log/views/notes.sql", "SELECT id, key, run_id FROM log.notes"),
    ("sources/log/writes/note.sql", "INSERT INTO log.notes (key, run_id) VALUES (:key, :run_id)"),
    (
        "sources/log/writes/notes.sql",
        "INSERT INTO log.notes (key, run_id) SELECT value, :run_id FROM json_each(:payload)",
    ),
];

fn home(extra: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), BASE);
    write(dir.path(), extra);
    dir
}

/// Reopening a folder right after dropping its engine can be refused for a few microseconds: a command another test
/// is spawning at that moment shares the lock file's descriptor until its exec closes it.
fn open(home: &Path) -> (Engine, Receiver<(String, Value)>) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let (tx, rx) = channel();
        match Engine::open(home, Events(Mutex::new(tx))) {
            Ok(engine) => return (engine, rx),
            Err(e) if e.to_string().contains("another instance") && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(e) => panic!("{e:#}"),
        }
    }
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
        assert!(Instant::now() < deadline, "timed out waiting on {name}: {rows:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn writer_rule_fires_once_per_key_across_restarts() {
    let h = home(&[(
        "rules/note.json",
        r#"{"id": "note", "when": {"view": "prs_items"}, "key": "{id}", "into": "log.note", "args": {"key": "{title}"}}"#,
    )]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    engine.write("prs.add", json!({"id": 2}), card()).unwrap();
    let notes = until(&engine, "log_notes", json!({}), 5, |r| r.len() == 2);
    assert_eq!(notes[0]["key"], "item 1");
    assert!(notes[0]["run_id"].is_string(), "writer-only firings run as a run: {notes:?}");
    drop(engine);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 3}), card()).unwrap();
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 3);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(engine.query("log_notes", json!({})).unwrap().as_array().unwrap().len(), 3);
    assert_eq!(engine.query("core_firings", json!({"rule": "note"})).unwrap().as_array().unwrap().len(), 3);
}

#[test]
fn depth_limit_blocks_and_consumes_the_key() {
    let h = home(&[
        ("settings.json", r#"{"max_depth": 3}"#),
        (
            "rules/chain.json",
            r#"{"id": "chain", "when": {"view": "prs_next"}, "key": "{id}", "into": "prs.add", "args": {"id": "{next}"}}"#,
        ),
    ]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    let firings =
        until(&engine, "core_firings", json!({"rule": "chain"}), 5, |r| r.iter().any(|f| f["blocked"].is_string()));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(engine.query("prs_items", json!({})).unwrap().as_array().unwrap().len(), 4);
    let blocked: Vec<_> = firings.iter().filter(|f| f["blocked"].is_string()).collect();
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0]["key"], "4");
    assert!(blocked[0]["blocked"].as_str().unwrap().contains("depth 4 exceeds max_depth 3"));
    let runs = engine.query("core_runs", json!({"rule": "chain"})).unwrap();
    let mut depths: Vec<i64> = runs.as_array().unwrap().iter().map(|r| r["depth"].as_i64().unwrap()).collect();
    depths.sort();
    assert_eq!(depths, [1, 2, 3]);
}

#[test]
fn rate_limit_blocks_and_disables_until_enabled() {
    let h = home(&[(
        "rules/note.json",
        r#"{"id": "note", "when": {"view": "prs_items"}, "key": "{id}", "into": "log.note", "args": {"key": "{title}"}, "max_per_hour": 2}"#,
    )]);
    let (engine, _rx) = open(h.path());
    for id in 1..=3 {
        engine.write("prs.add", json!({"id": id}), card()).unwrap();
    }
    until(&engine, "core_rules", json!({"rule": "note"}), 5, |r| r[0]["enabled"] == 0);
    let rules = engine.query("core_rules", json!({"rule": "note"})).unwrap();
    assert_eq!(rules[0]["disabled_reason"], "max_per_hour 2 exceeded");
    assert_eq!(engine.query("log_notes", json!({})).unwrap().as_array().unwrap().len(), 2);
    engine.write("prs.add", json!({"id": 4}), card()).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        engine.query("core_firings", json!({"rule": "note", "key": "4"})).unwrap().as_array().unwrap().is_empty(),
        "disabled rules do not fire"
    );
    engine.write("core.rule_enable", json!({"rule": "note"}), card()).unwrap();
    let f = until(&engine, "core_firings", json!({"rule": "note", "key": "4"}), 5, |r| !r.is_empty());
    assert!(
        f[0]["blocked"].as_str().unwrap().contains("max_per_hour"),
        "re-enabled rule re-evaluates and is still over its rate: {f:?}"
    );
}

#[test]
fn concurrency_limit_queues_rule_runs() {
    let h = home(&[
        ("settings.json", r#"{"max_concurrency": 1}"#),
        ("sources/prs/commands/work.sh", "#!/bin/sh\nsleep 0.3\n"),
        (
            "rules/work.json",
            r#"{"id": "work", "when": {"view": "prs_items"}, "key": "{id}", "run": "prs.work", "args": {"pr": "{id}"}}"#,
        ),
    ]);
    let (engine, _rx) = open(h.path());
    for id in 1..=3 {
        engine.write("prs.add", json!({"id": id}), card()).unwrap();
    }
    let runs = until(&engine, "core_runs", json!({"rule": "work"}), 5, |r| r.len() == 3);
    let states: Vec<&str> = runs.iter().map(|r| r["state"].as_str().unwrap()).collect();
    assert_eq!(states.iter().filter(|s| **s == "running").count(), 1, "{states:?}");
    assert_eq!(states.iter().filter(|s| **s == "queued").count(), 2, "{states:?}");
    let manual = engine.run("prs.work", json!({}), card()).unwrap();
    let m = until(&engine, "core_runs", json!({"id": manual}), 2, |r| r[0]["state"] != "queued");
    assert_eq!(m[0]["state"], "running", "manual runs are never queued");
    let runs = until(&engine, "core_runs", json!({"rule": "work"}), 10, |r| r.iter().all(|x| x["state"] == "success"));
    let mut spans: Vec<(String, String)> = runs
        .iter()
        .map(|r| (r["started_at"].as_str().unwrap().into(), r["finished_at"].as_str().unwrap().into()))
        .collect();
    spans.sort();
    assert!(spans.windows(2).all(|w| w[0].1 <= w[1].0), "rule runs overlapped: {spans:?}");
}

#[test]
fn into_receives_stdout_and_args_reach_the_command() {
    let h = home(&[
        ("sources/prs/commands/fetch", "#!/bin/sh\nread args\necho \"[\\\"$SWB_ARG_PR\\\", $args]\"\n"),
        (
            "rules/fetch.json",
            r#"{"id": "fetch", "when": {"view": "prs_items"}, "key": "{id}", "run": "prs.fetch", "args": {"pr": "{id}"}, "into": "log.notes"}"#,
        ),
    ]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 7}), card()).unwrap();
    let notes = until(&engine, "log_notes", json!({}), 10, |r| r.len() == 2);
    assert_eq!(notes[0]["key"], "7");
    assert_eq!(notes[1]["key"], r#"{"pr":7}"#);
    let run = until(&engine, "core_runs", json!({"rule": "fetch"}), 5, |r| r[0]["state"] == "success");
    assert_eq!(notes[0]["run_id"], run[0]["id"]);
    let log = fs::read_to_string(h.path().join(format!("data/logs/{}.log", run[0]["id"].as_str().unwrap()))).unwrap();
    assert!(log.contains(r#"["7", {"pr":7}]"#), "{log}");
}

#[test]
fn final_stdout_line_refines_state_and_finish_closes_open_runs() {
    let h = home(&[(
        "sources/prs/commands/launch",
        "#!/bin/sh\necho working\necho \"{\\\"outcome\\\": \\\"open\\\", \\\"summary\\\": \\\"agent detached from $SOURCE_DIR\\\"}\"\n",
    )]);
    let (engine, _rx) = open(h.path());
    let id = engine.run("prs.launch", json!({}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": id}), 5, |r| r[0]["state"] == "open");
    let source = h.path().canonicalize().unwrap().join("sources/prs");
    assert_eq!(run[0]["summary"], format!("agent detached from {}", source.display()));
    engine.finish_run(&id, true, Some("merged")).unwrap();
    let run = engine.query("core_runs", json!({"id": id})).unwrap();
    assert_eq!((run[0]["state"].as_str(), run[0]["summary"].as_str()), (Some("success"), Some("merged")));
    assert!(engine.finish_run(&id, false, None).is_err(), "finished runs cannot be finished again");
}

#[test]
fn a_run_sent_twice_with_its_id_starts_once() {
    let h = home(&[("sources/prs/commands/launch", "#!/bin/sh\n")]);
    let (engine, _rx) = open(h.path());
    let id = "7f6c2a8e-34d1-4b8e-9a51-0c2e9d1f6b3a";
    assert_eq!(engine.run_as(id, "prs.launch", json!({}), card()).unwrap(), id);
    assert_eq!(engine.run_as(id, "prs.launch", json!({}), card()).unwrap(), id);
    until(&engine, "core_runs", json!({"id": id}), 5, |r| r[0]["state"] == "success");
    assert_eq!(engine.query("core_runs", json!({"command": "prs.launch"})).unwrap().as_array().unwrap().len(), 1);
    let generated = engine.run("prs.launch", json!({}), card()).unwrap();
    assert!(uuid_like(&generated), "{generated}");
}

fn uuid_like(id: &str) -> bool {
    id.len() == 36 && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
}

#[test]
fn timeout_kills_the_process_group() {
    let h = home(&[
        ("sources/prs/source.json", r#"{"timeouts": {"slow": 1}}"#),
        ("sources/prs/commands/slow", "#!/bin/sh\nsleep 30 &\necho $! > \"$SWITCHBOARD_HOME/child.pid\"\nwait\n"),
    ]);
    let (engine, _rx) = open(h.path());
    let start = Instant::now();
    let id = engine.run("prs.slow", json!({}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": id}), 5, |r| r[0]["state"] == "failure");
    assert_eq!(run[0]["summary"], "timed out after 1s");
    assert!(start.elapsed() < Duration::from_secs(3));
    let log = fs::read_to_string(h.path().join(format!("data/logs/{id}.log"))).unwrap_or_default();
    let child: i32 =
        fs::read_to_string(h.path().join("child.pid")).unwrap_or_else(|e| panic!("{e}: {log}")).trim().parse().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_ne!(unsafe { libc::kill(child, 0) }, 0, "the background child was killed with the group");
}

#[test]
fn running_rows_whose_process_is_gone_become_unknown_on_start() {
    let h = home(&[]);
    drop(open(h.path()));
    let mut gone = std::process::Command::new("true").spawn().unwrap();
    let pid = gone.id();
    gone.wait().unwrap();
    let db = rusqlite::Connection::open(h.path().join("data/core.db")).unwrap();
    db.execute("INSERT INTO runs (id, command, state, pid, created_at, started_at) VALUES ('lost', 'prs.x', 'running', ?1, 0, 0)", [pid]).unwrap();
    db.execute(
        "INSERT INTO runs (id, command, state, created_at, started_at) VALUES ('stale', 'prs.x', 'open', 0, 0)",
        [],
    )
    .unwrap();
    drop(db);
    let (engine, _rx) = open(h.path());
    let lost = until(&engine, "core_runs", json!({"id": "lost"}), 5, |r| r[0]["state"] == "unknown");
    assert_eq!(lost[0]["summary"], "process gone");
    let stale = until(&engine, "core_runs", json!({"id": "stale"}), 5, |r| r[0]["state"] == "unknown");
    assert_eq!(stale[0]["summary"], "expired while open");
}

#[test]
fn schedule_fires_once_per_slot_and_once_for_missed_slots() {
    let h = home(&[(
        "rules/beat.json",
        r#"{"id": "beat", "when": {"schedule": "*/5 * * * *"}, "into": "log.note", "args": {"key": "beat"}}"#,
    )]);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_rules", json!({"rule": "beat"}), 5, |r| {
        r.first().is_some_and(|r| r["last_evaluated"].is_string())
    });
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let base = now - now % 300_000 + 3_600_000;
    let notes = |n: usize| until(&engine, "log_notes", json!({}), 5, |r| r.len() == n);
    engine.tick(base + 60_000);
    notes(1);
    engine.tick(base + 120_000);
    engine.tick(base + 240_000);
    std::thread::sleep(Duration::from_millis(200));
    notes(1);
    engine.tick(base + 3 * 3_600_000);
    notes(2);
    std::thread::sleep(Duration::from_millis(200));
    let firings = notes(2);
    assert_eq!(firings.len(), 2);
    let keys: Vec<Value> = engine
        .query("core_firings", json!({"rule": "beat"}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].clone())
        .collect();
    assert_eq!(keys.len(), 2);
    assert!(keys.iter().all(|k| k.as_str().unwrap().starts_with("slot:")), "{keys:?}");
}

#[test]
fn snapshot_and_restore() {
    let h = home(&[]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    let snap = engine.run("core.snapshot", json!({"source": "prs"}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": snap}), 5, |r| r[0]["state"] == "success");
    let taken: i64 =
        run[0]["summary"].as_str().unwrap().rsplit('/').next().unwrap().trim_end_matches(".db").parse().unwrap();
    engine.write("prs.add", json!({"id": 2}), card()).unwrap();
    let before = fs::read_dir(h.path().join("data/snapshots/prs")).unwrap().count();
    let (id, rows) = engine.subscribe("prs_items", json!({})).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    let restore = engine.run("core.restore", json!({"source": "prs", "snapshot": taken}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": restore}), 5, |r| {
        r[0]["state"] != "running" && r[0]["state"] != "queued"
    });
    assert_eq!(run[0]["state"], "success", "{run:?}");
    assert_eq!(engine.query("prs_items", json!({})).unwrap(), json!([{"id": 1, "title": "item 1"}]));
    let snapshots = fs::read_dir(h.path().join("data/snapshots/prs")).unwrap().count();
    assert_eq!(snapshots, before + 1, "restore keeps a copy of the state it replaced");
    engine.write("prs.add", json!({"id": 3}), card()).unwrap();
    assert_eq!(engine.query("prs_items", json!({})).unwrap().as_array().unwrap().len(), 2);
    engine.unsubscribe(id);
    let bad = engine.run("core.restore", json!({}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": bad}), 5, |r| r[0]["state"] == "failure");
    assert!(run[0]["summary"].as_str().unwrap().contains("needs {\"source\": name}"));
}

#[test]
fn degraded_start_exposes_errors_and_recovers() {
    let h = home(&[("sources/prs/views/broken.sql", "SELECT nope FROM prs.items")]);
    let (engine, rx) = open(h.path());
    let config = engine.config();
    assert_eq!(config["errors"][0]["path"], "sources/prs/views/broken.sql:1:8", "{config}");
    assert!(engine.query("prs_items", json!({})).is_err(), "only core is loaded");
    until(&engine, "core_events", json!({"kind": "error"}), 5, |r| {
        r.iter().any(|e| e["name"].as_str().unwrap().contains("broken.sql"))
    });
    fs::remove_file(h.path().join("sources/prs/views/broken.sql")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.query("prs_items", json!({})).is_err() {
        assert!(Instant::now() < deadline, "did not recover");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(engine.config()["errors"], json!([]));
    assert!(rx.try_iter().any(|(e, _)| e == "config"));
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
}

#[test]
fn ref_ids_as_strings_match_integer_and_untyped_columns() {
    let h = home(&[(
        "sources/prs/views/raw.sql",
        "SELECT id, json_object('id', id) ->> '$.id' AS rid, CAST(id AS TEXT) AS sid FROM prs.items",
    )]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 4812}), card()).unwrap();
    for filter in [
        json!({"id": "4812"}),
        json!({"rid": "4812"}),
        json!({"rid": 4812}),
        json!({"sid": 4812}),
        json!({"sid": "4812"}),
    ] {
        assert_eq!(engine.query("prs_raw", filter.clone()).unwrap().as_array().unwrap().len(), 1, "{filter}");
    }
    assert!(engine.query("prs_raw", json!({"rid": "04812"})).unwrap().as_array().unwrap().is_empty());
}

#[test]
fn first_run_creates_a_git_folder_from_the_template() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().join("home");
    let (engine, _rx) = open(&h);
    assert!(h.join("cards/Root.tsx").exists());
    assert!(!h.join("data/spool").exists());
    assert_eq!(engine.query("ui.boards", json!({})).unwrap(), json!([]));
    assert_eq!(fs::read_to_string(h.join(".gitignore")).unwrap(), "data/\ncards/switchboard.d.ts\n");
    let hook = fs::read_to_string(h.join(".git/hooks/pre-commit")).unwrap();
    assert!(hook.contains("exec \"$SWB\" check"), "{hook}");
    let log = std::process::Command::new("git").current_dir(&h).args(["log", "--oneline"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout).lines().count(), 1);
    let config = engine.config();
    assert_eq!(config["root"], "Root");
    assert_eq!(config["depth_cap"], 20);
    assert!(config["cards"].as_array().unwrap().contains(&json!("Health")));
    assert!(config["commands"].as_array().unwrap().contains(&json!("core.snapshot")));
    assert!(config["writers"].as_array().unwrap().contains(&json!("core.rule_enable")));
    let git = |args: &[&str]| std::process::Command::new("git").current_dir(&h).args(args).output().unwrap();
    fs::write(h.join("cards/Root.tsx"), "export default function Root() { return null }\n").unwrap();
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "edit", "--no-verify"]);
    engine.revert_last_commit().unwrap();
    assert_ne!(
        fs::read_to_string(h.join("cards/Root.tsx")).unwrap(),
        "export default function Root() { return null }\n"
    );
}

#[test]
fn report_error_and_orphans() {
    let h = home(&[]);
    let (engine, _rx) = open(h.path());
    engine.report_error("Grid", "boom", "at Grid");
    let errors = until(&engine, "core_events", json!({"kind": "error", "name": "Grid"}), 5, |r| !r.is_empty());
    assert_eq!(
        (errors[0]["trigger"].as_str(), errors[0]["message"].as_str()),
        (Some("card_runtime"), Some("boom\nat Grid"))
    );
    fs::write(h.path().join("data/ghost.db"), "").unwrap();
    engine.tick(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64);
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.path().join("data/ghost.db").exists() {
        assert!(Instant::now() < deadline, "orphan not moved");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_dir(h.path().join("data/trash")).unwrap().count(), 1);
}

#[test]
fn cards_are_served_and_recompiles_are_announced() {
    let h = home(&[
        (
            "cards/Root.tsx",
            "import { label } from \"./lib/label\"\nexport default function Root() { return <div>{label}</div> }\n",
        ),
        ("cards/Plain.tsx", "export default function Plain() { return <div>plain</div> }\n"),
        ("cards/lib/label.ts", "export const label = \"one\"\n"),
    ]);
    let (engine, rx) = open(h.path());
    assert!(engine.card("Root").unwrap()["lib/label.ts"].as_str().unwrap().contains("\"one\""));
    assert!(engine.card("Nope").is_err());
    write(h.path(), &[("cards/switchboard.d.ts", "declare module \"switchboard\" {}\n")]);
    std::thread::sleep(Duration::from_millis(400));
    assert!(!rx.try_iter().any(|(e, _)| e == "config"), "switchboard.d.ts is ignored by the watcher");
    let changed = |file: &str, text: &str| {
        write(h.path(), &[(file, text)]);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut cards = Vec::new();
        while !rx.recv_timeout(Duration::from_millis(100)).is_ok_and(|(e, _)| e == "config") {
            assert!(Instant::now() < deadline, "no reload");
        }
        while let Ok((e, p)) = rx.recv_timeout(Duration::from_millis(200)) {
            if e == "card" {
                cards.push(p["name"].as_str().unwrap().to_string());
            }
        }
        cards
    };
    assert_eq!(changed("cards/lib/label.ts", "export const label = \"two\"\n"), ["Root"]);
    assert!(engine.card("Root").unwrap()["lib/label.ts"].as_str().unwrap().contains("\"two\""));
    assert_eq!(changed("cards/Plain.tsx", "export default function Plain() { return <div>three</div> }\n"), ["Plain"]);
    assert!(engine.card("Plain").unwrap()["Plain.tsx"].as_str().unwrap().contains("\"three\""));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

#[track_caller]
fn wait_for(what: &str, secs: u64, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn count(dir: &Path) -> usize {
    fs::read_dir(dir).map_or(0, |d| d.count())
}

#[test]
fn logs_are_truncated_at_one_megabyte() {
    let h = home(&[("sources/prs/commands/noisy", "#!/bin/sh\nhead -c 3000000 /dev/zero | tr '\\0' x\n")]);
    let (engine, _rx) = open(h.path());
    let id = engine.run("prs.noisy", json!({}), card()).unwrap();
    until(&engine, "core_runs", json!({"id": id}), 10, |r| r[0]["state"] == "success");
    let log = fs::read(h.path().join(format!("data/logs/{id}.log"))).unwrap();
    assert!(log.len() > 1 << 20 && log.len() < (1 << 20) + 100, "{}", log.len());
    assert!(log.ends_with(b"\n[log truncated at 1 MB]\n"));
}

#[test]
fn retention_trims_events_runs_logs_and_slot_firings() {
    let h = home(&[("settings.json", r#"{"retention": 60}"#)]);
    drop(open(h.path()));
    let db = rusqlite::Connection::open(h.path().join("data/core.db")).unwrap();
    db.execute_batch(
        "INSERT INTO events (at, kind, name) VALUES (0, 'error', 'old');
         INSERT INTO runs (id, command, state, created_at, finished_at) VALUES ('old', 'prs.x', 'success', 0, 0), ('kept', 'prs.x', 'open', 0, NULL);
         INSERT INTO firings (rule, key, at) VALUES ('r', 'slot:2020-01-01T00:00', 0), ('r', '42', 0);",
    )
    .unwrap();
    drop(db);
    fs::create_dir_all(h.path().join("data/logs")).unwrap();
    fs::write(h.path().join("data/logs/old.log"), "x").unwrap();
    let (engine, _rx) = open(h.path());
    engine.tick(now_ms());
    until(&engine, "core_runs", json!({"id": "old"}), 5, |r| r.is_empty());
    assert!(!h.path().join("data/logs/old.log").exists());
    assert!(engine.query("core_events", json!({"name": "old"})).unwrap().as_array().unwrap().is_empty());
    let firings = engine.query("core_firings", json!({"rule": "r"})).unwrap();
    assert_eq!(firings.as_array().unwrap().len(), 1, "only slot keys are trimmed: {firings}");
    assert_eq!(firings[0]["key"], "42");
    assert_eq!(engine.query("core_runs", json!({"id": "kept"})).unwrap().as_array().unwrap().len(), 1);
}

#[test]
fn snapshots_skip_unchanged_databases_and_keep_the_newest() {
    let h = home(&[("settings.json", r#"{"snapshot_interval": 60, "snapshot_retention": 600}"#)]);
    let (engine, _rx) = open(h.path());
    let dir = h.path().join("data/snapshots/prs");
    wait_for("startup snapshot", 5, || count(&dir) == 1);
    let start = now_ms();
    engine.tick(start + 120_000);
    assert_eq!(count(&dir), 1, "unchanged database is not snapshotted again");
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    engine.tick(start + 240_000);
    assert_eq!(count(&dir), 2);
    engine.write("prs.add", json!({"id": 2}), card()).unwrap();
    engine.tick(start + 10_000_000);
    assert_eq!(count(&dir), 2, "the oldest expired snapshot is deleted");
    engine.tick(start + 10_000_001);
    assert_eq!(count(&dir), 1, "expired snapshots are deleted, the newest is always kept");
}

#[test]
fn queued_runs_resume_after_restart() {
    let h = home(&[("sources/prs/commands/work", "#!/bin/sh\n")]);
    drop(open(h.path()));
    let db = rusqlite::Connection::open(h.path().join("data/core.db")).unwrap();
    db.execute(
        "INSERT INTO runs (id, command, args, state, created_at) VALUES ('waiting', 'prs.work', '{}', 'queued', 0)",
        [],
    )
    .unwrap();
    drop(db);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_runs", json!({"id": "waiting"}), 5, |r| r[0]["state"] == "success");
}

#[test]
fn rule_with_view_and_schedule_re_evaluates_on_its_schedule() {
    let h = home(&[
        ("sources/prs/views/due.sql", "SELECT id, title FROM prs.items WHERE id <= unixepoch()"),
        (
            "rules/due.json",
            r#"{"id": "due", "when": {"view": "prs_due", "schedule": "* * * * *"}, "key": "{id}", "into": "log.note", "args": {"key": "{title}"}}"#,
        ),
    ]);
    // The real minute tick must not evaluate the schedule while the test waits.
    let into_minute = now_ms().rem_euclid(60_000);
    if into_minute > 55_000 {
        std::thread::sleep(Duration::from_millis((60_100 - into_minute) as u64));
    }
    let (engine, _rx) = open(h.path());
    let soon = now_ms() / 1000 + 2;
    engine.write("prs.add", json!({"id": soon}), card()).unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        engine.query("log_notes", json!({})).unwrap().as_array().unwrap().is_empty(),
        "no write, so no view evaluation yet"
    );
    engine.tick(now_ms() + 61_000);
    let notes = until(&engine, "log_notes", json!({}), 5, |r| r.len() == 1);
    assert_eq!(notes[0]["key"], format!("item {soon}"));
}

#[test]
fn failing_into_write_fails_the_run_without_partial_writes() {
    let h = home(&[
        (
            "sources/log/writes/bad.sql",
            "INSERT INTO log.notes (key) SELECT value FROM json_each(:payload);\nINSERT INTO log.notes (id, key) VALUES (1, 'x');",
        ),
        ("sources/prs/commands/emit", "#!/bin/sh\necho '[\"a\", \"b\"]'\n"),
        (
            "rules/emit.json",
            r#"{"id": "emit", "when": {"view": "prs_items"}, "key": "{id}", "run": "prs.emit", "into": "log.bad"}"#,
        ),
    ]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"rule": "emit"}), 10, |r| {
        r.first().is_some_and(|r| r["state"] == "failure")
    });
    assert!(run[0]["summary"].as_str().unwrap().contains("UNIQUE constraint failed"), "{run:?}");
    until(&engine, "core_events", json!({"kind": "error", "name": "log.bad"}), 5, |r| !r.is_empty());
    assert_eq!(engine.query("log_notes", json!({})).unwrap(), json!([]));
}

#[test]
fn reload_with_a_changed_rule_definition_evaluates_the_new_one() {
    let h = home(&[(
        "rules/note.json",
        r#"{"id": "note", "when": {"view": "prs_items"}, "key": "{id}", "into": "log.note", "args": {"key": "v1 {title}"}}"#,
    )]);
    let (engine, _rx) = open(h.path());
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 1);
    write(
        h.path(),
        &[(
            "rules/note.json",
            r#"{"id": "note", "when": {"view": "prs_items"}, "key": "{id}-v2", "into": "log.note", "args": {"key": "v2 {title}"}}"#,
        )],
    );
    let notes = until(&engine, "log_notes", json!({}), 5, |r| r.len() == 2);
    assert_eq!(notes[1]["key"], "v2 item 1");
}

#[test]
fn dropping_the_engine_kills_running_commands() {
    let h = home(&[(
        "sources/prs/commands/hang",
        "#!/bin/sh\nsleep 30 &\necho $! > \"$SWITCHBOARD_HOME/child.pid\"\nwait\n",
    )]);
    let (engine, _rx) = open(h.path());
    engine.run("prs.hang", json!({}), card()).unwrap();
    let pid_file = h.path().join("child.pid");
    wait_for("command start", 5, || fs::read_to_string(&pid_file).is_ok_and(|p| p.ends_with('\n')));
    let child: i32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    drop(engine);
    std::thread::sleep(Duration::from_millis(100));
    assert_ne!(unsafe { libc::kill(child, 0) }, 0, "the command's process group outlived the engine");
}

#[test]
fn trash_is_deleted_after_thirty_days() {
    let h = home(&[]);
    let (engine, _rx) = open(h.path());
    let trash = h.path().join("data/trash");
    fs::create_dir_all(&trash).unwrap();
    let now = now_ms();
    fs::write(trash.join(format!("ghost.{}.db", now - 31 * 86_400_000)), "").unwrap();
    fs::write(trash.join(format!("ghost.{}.db", now - 29 * 86_400_000)), "").unwrap();
    engine.tick(now);
    wait_for("trash deletion", 5, || count(&trash) == 1);
}

#[test]
fn a_second_instance_on_the_same_home_refuses_to_start() {
    let h = home(&[]);
    let (_engine, _rx) = open(h.path());
    let (tx, _rx2) = channel();
    let second = Engine::open(h.path(), Events(Mutex::new(tx)));
    assert!(second.err().unwrap().to_string().contains("another instance of the app is already running"));
}

#[test]
fn a_rule_added_by_reload_fires_at_its_next_slot() {
    let h = home(&[]);
    let (engine, _rx) = open(h.path());
    write(
        h.path(),
        &[(
            "rules/beat.json",
            r#"{"id": "beat", "when": {"schedule": "*/5 * * * *"}, "into": "log.note", "args": {"key": "beat"}}"#,
        )],
    );
    until(&engine, "core_rules", json!({"rule": "beat"}), 5, |r| !r.is_empty());
    let now = now_ms();
    engine.tick(now - now % 300_000 + 300_000 + 1_000);
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 1);
}

#[test]
fn stdout_is_bounded_tail_without_into_and_capped_with_into() {
    let h = home(&[
        (
            "sources/prs/commands/chatty",
            "#!/bin/sh\nhead -c 5000000 /dev/zero | tr '\\0' x\necho\necho '{\"outcome\": \"open\", \"summary\": \"tail kept\"}'\n",
        ),
        ("sources/prs/commands/flood", "#!/bin/sh\nhead -c 17000000 /dev/zero | tr '\\0' x\n"),
        (
            "rules/flood.json",
            r#"{"id": "flood", "when": {"view": "prs_items"}, "key": "{id}", "run": "prs.flood", "into": "log.notes"}"#,
        ),
    ]);
    let (engine, _rx) = open(h.path());
    let id = engine.run("prs.chatty", json!({}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"id": id}), 10, |r| r[0]["state"] == "open");
    assert_eq!(run[0]["summary"], "tail kept");
    engine.write("prs.add", json!({"id": 1}), card()).unwrap();
    let run = until(&engine, "core_runs", json!({"rule": "flood"}), 10, |r| {
        r.first().is_some_and(|r| r["state"] == "failure")
    });
    assert_eq!(run[0]["summary"], "stdout exceeded the 16 MB payload limit; nothing was written to log.notes");
}

#[test]
fn schedule_only_writer_rules_skip_the_rate_limit_and_record_no_runs() {
    let h = home(&[(
        "rules/beat.json",
        r#"{"id": "beat", "when": {"schedule": "* * * * *"}, "into": "log.note", "args": {"key": "beat"}}"#,
    )]);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_rules", json!({"rule": "beat"}), 5, |r| {
        r.first().is_some_and(|r| r["last_evaluated"].is_string())
    });
    let base = now_ms() - now_ms() % 60_000 + 3_600_000;
    for i in 0..90 {
        engine.tick(base + i * 60_000);
    }
    let notes = until(&engine, "log_notes", json!({}), 10, |r| r.len() == 90);
    assert!(notes.iter().all(|n| n["run_id"].is_null()), "{notes:?}");
    assert_eq!(engine.query("core_firings", json!({"rule": "beat"})).unwrap().as_array().unwrap().len(), 90);
    assert_eq!(engine.query("core_rules", json!({"rule": "beat"})).unwrap()[0]["enabled"], 1);
    assert_eq!(engine.query("core_runs", json!({"rule": "beat"})).unwrap(), json!([]));
    let writes = engine.query("core_events", json!({"kind": "write", "name": "log.note"})).unwrap();
    assert_eq!((writes[0]["trigger"].as_str(), writes[0]["run_id"].as_str()), (Some("rule:beat"), None));
}

#[test]
fn writes_that_change_nothing_are_not_logged() {
    let h = home(&[]);
    let (engine, _rx) = open(h.path());
    assert_eq!(engine.write("prs.add", json!({"id": 1}), card()).unwrap(), 1);
    assert_eq!(engine.write("prs.add", json!({"id": 1}), card()).unwrap(), 0);
    assert_eq!(
        engine.query("core_events", json!({"kind": "write", "name": "prs.add"})).unwrap().as_array().unwrap().len(),
        1
    );
}

#[test]
fn a_core_db_with_the_old_attention_table_still_opens() {
    let h = home(&[]);
    drop(open(h.path()));
    let db = rusqlite::Connection::open(h.path().join("data/core.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE attention (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, reason TEXT, level INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, cleared_at INTEGER, snooze_until INTEGER);
         CREATE UNIQUE INDEX attention_open ON attention (ref) WHERE cleared_at IS NULL;
         INSERT INTO attention (ref, created_at) VALUES ('x:1', 0);",
    )
    .unwrap();
    drop(db);
    let (engine, _rx) = open(h.path());
    assert_eq!(engine.config()["errors"], json!([]));
    let db = rusqlite::Connection::open(h.path().join("data/core.db")).unwrap();
    let left: i64 =
        db.query_row("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'attention%'", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn file_rules_fire_on_changes_and_on_appended_matching_lines() {
    let watched = tempfile::tempdir().unwrap();
    let log = watched.path().join("app.log");
    fs::write(&log, "ERROR before the engine started\n").unwrap();
    let pattern = watched.path().join("*.log").display().to_string();
    let h = home(&[
        (
            "rules/changed.json",
            &format!(r#"{{"id": "changed", "when": {{"files": "{pattern}"}}, "into": "log.note", "args": {{"key": "changed"}}}}"#),
        ),
        (
            "rules/errors.json",
            &format!(r#"{{"id": "errors", "when": {{"files": "{pattern}", "line_contains": "ERROR"}}, "into": "log.note", "args": {{"key": "{{line}}"}}}}"#),
        ),
    ]);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_rules", json!({"rule": "errors"}), 5, |r| r.len() == 1);
    std::thread::sleep(Duration::from_millis(300));
    let append = |text: &[u8]| {
        std::io::Write::write_all(&mut fs::OpenOptions::new().append(true).open(&log).unwrap(), text).unwrap()
    };
    append(b"ok\nERROR one\nERROR two\nERROR partial");
    let notes = until(&engine, "log_notes", json!({}), 5, |r| r.len() == 3);
    let keys: Vec<&str> = notes.iter().map(|n| n["key"].as_str().unwrap()).collect();
    assert_eq!(keys.iter().filter(|k| **k == "changed").count(), 1, "{keys:?}");
    assert!(keys.contains(&"ERROR one") && keys.contains(&"ERROR two"), "{keys:?}");
    append(b" ends\n");
    let notes = until(&engine, "log_notes", json!({}), 5, |r| r.len() == 5);
    assert!(notes.iter().any(|n| n["key"] == "ERROR partial ends"), "{notes:?}");
}

#[test]
fn system_rules_fire_and_offline_waits_for_its_debounce() {
    let rule = |event: &str| {
        format!(r#"{{"id": "{event}", "when": {{"system": "{event}"}}, "into": "log.note", "args": {{"key": "{{event}}"}}}}"#)
    };
    let (wake, offline, online) = (rule("wake"), rule("offline"), rule("online"));
    let h = home(&[
        ("settings.json", r#"{"offline_debounce": 1}"#),
        ("rules/wake.json", &wake),
        ("rules/offline.json", &offline),
        ("rules/online.json", &online),
    ]);
    let (engine, _rx) = open(h.path());
    let keys = || -> Vec<String> {
        let notes = engine.query("log_notes", json!({})).unwrap();
        notes.as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap().to_string()).collect()
    };
    engine.system_event(SystemEvent::Wake);
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 1);
    engine.system_event(SystemEvent::Online);
    engine.system_event(SystemEvent::Offline);
    std::thread::sleep(Duration::from_millis(300));
    engine.system_event(SystemEvent::Online);
    std::thread::sleep(Duration::from_millis(1200));
    assert_eq!(keys(), ["wake"], "a brief drop fires nothing");
    engine.system_event(SystemEvent::Offline);
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 2);
    engine.system_event(SystemEvent::Offline);
    engine.system_event(SystemEvent::Online);
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 3);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(keys(), ["wake", "offline", "online"]);
}

#[test]
fn unlogged_schedule_rules_fire_once_per_slot_without_firings_or_write_events() {
    let h = home(&[(
        "rules/beat.json",
        r#"{"id": "beat", "when": {"schedule": "*/5 * * * *"}, "into": "log.note", "args": {"key": "beat"}, "log": false}"#,
    )]);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_rules", json!({"rule": "beat"}), 5, |r| {
        r.first().is_some_and(|r| r["last_evaluated"].is_string())
    });
    let base = now_ms() - now_ms() % 300_000 + 3_600_000;
    for offset in [60_000, 120_000, 240_000, 3 * 3_600_000] {
        engine.tick(base + offset);
    }
    until(&engine, "log_notes", json!({}), 5, |r| r.len() == 2);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(engine.query("log_notes", json!({})).unwrap().as_array().unwrap().len(), 2);
    assert_eq!(engine.query("core_firings", json!({"rule": "beat"})).unwrap(), json!([]));
    assert_eq!(engine.query("core_events", json!({"kind": "write", "name": "log.note"})).unwrap(), json!([]));
}

#[test]
fn unlogged_file_rules_with_runs_are_rate_limited_by_their_runs() {
    let watched = tempfile::tempdir().unwrap();
    let log = watched.path().join("app.log");
    fs::write(&log, "").unwrap();
    let pattern = watched.path().join("*.log").display().to_string();
    let rule = format!(
        r#"{{"id": "errors", "when": {{"files": "{pattern}", "line_contains": "ERROR"}}, "run": "core.notify", "args": {{"title": "{{line}}", "body": ""}}, "max_per_hour": 2, "log": false}}"#
    );
    let h = home(&[("rules/errors.json", &rule)]);
    let (engine, _rx) = open(h.path());
    until(&engine, "core_rules", json!({"rule": "errors"}), 5, |r| r.len() == 1);
    std::thread::sleep(Duration::from_millis(300));
    std::io::Write::write_all(&mut fs::OpenOptions::new().append(true).open(&log).unwrap(), b"ERROR 1\nERROR 2\nERROR 3\n")
        .unwrap();
    let rules = until(&engine, "core_rules", json!({"rule": "errors"}), 5, |r| r[0]["enabled"] == 0);
    assert_eq!(rules[0]["disabled_reason"], "max_per_hour 2 exceeded");
    assert_eq!(engine.query("core_runs", json!({"rule": "errors"})).unwrap().as_array().unwrap().len(), 2);
    let firings = engine.query("core_firings", json!({"rule": "errors"})).unwrap();
    assert_eq!(firings.as_array().unwrap().len(), 1, "only the blocked firing is recorded: {firings}");
}
