use switchboard_core::{Emitter, Engine, Mode, Origin, load};
use serde_json::{Value, json};
use std::fs;
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
    }
}

fn open(home: &Path) -> (Engine, Receiver<(String, Value)>) {
    let (tx, rx) = channel();
    (Engine::open(home, Events(Mutex::new(tx))).unwrap(), rx)
}

fn card() -> Origin {
    Origin { trigger: "card".into(), run_id: None }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
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
fn checks_without_errors_or_warnings() {
    let loaded = load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../template"), Mode::Check)
        .unwrap_or_else(|d| panic!("{}", d.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")));
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
}

fn template_home() -> (tempfile::TempDir, Engine, Receiver<(String, Value)>) {
    let dir = tempfile::tempdir().unwrap();
    let (engine, rx) = open(&dir.path().join("home"));
    (dir, engine, rx)
}

fn notified(rx: &Receiver<(String, Value)>, wait: Duration) -> Vec<Value> {
    let deadline = Instant::now() + wait;
    let mut out = Vec::new();
    while let Ok((e, p)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        out.extend((e == "notify").then_some(p));
    }
    out
}

#[test]
fn attention_notifies_once_per_item() {
    let (_dir, engine, rx) = template_home();
    engine.write("attention.raise", json!({"ref": "x:1", "reason": "test", "level": 2}), card()).unwrap();
    engine.write("attention.raise", json!({"ref": "x:1", "reason": "again", "level": 2}), card()).unwrap();
    engine.write("attention.raise", json!({"ref": "x:2", "reason": "quiet", "level": 1}), card()).unwrap();
    let open = until(&engine, "attention_open", json!({}), 5, |r| r.len() == 2);
    assert_eq!(open[0]["reason"], "again");
    assert_eq!(notified(&rx, Duration::from_millis(500)), [json!({"title": "x:1", "body": "test"})]);
    let runs = engine.query("core_runs", json!({"rule": "attention-notify"})).unwrap();
    assert_eq!((runs.as_array().unwrap().len(), runs[0]["state"].as_str()), (1, Some("success")));
}

#[test]
fn attention_snoozes_and_wakes_on_its_schedule() {
    let (_dir, engine, _rx) = template_home();
    until(&engine, "core_rules", json!({"rule": "attention-wake"}), 5, |r| {
        r.first().is_some_and(|r| r["last_evaluated"].is_string())
    });
    engine.write("attention.raise", json!({"ref": "x:1", "reason": "test", "level": 1}), card()).unwrap();
    engine.write("attention.snooze", json!({"ref": "x:1", "until": now_ms()}), card()).unwrap();
    assert_eq!(engine.query("attention_items", json!({"ref": "x:1"})).unwrap()[0]["state"], "snoozed");
    assert_eq!(engine.query("attention_open", json!({})).unwrap(), json!([]));
    engine.tick(now_ms() + 61_000);
    until(&engine, "attention_open", json!({"ref": "x:1"}), 5, |r| r.len() == 1);
}

#[test]
fn attention_notifies_again_after_waking() {
    let (_dir, engine, rx) = template_home();
    until(&engine, "core_rules", json!({"rule": "attention-wake"}), 5, |r| {
        r.first().is_some_and(|r| r["last_evaluated"].is_string())
    });
    engine.write("attention.raise", json!({"ref": "x:1", "reason": "test", "level": 2}), card()).unwrap();
    assert_eq!(notified(&rx, Duration::from_millis(500)).len(), 1);
    engine.write("attention.snooze", json!({"ref": "x:1", "until": now_ms()}), card()).unwrap();
    engine.tick(now_ms() + 61_000);
    until(&engine, "attention_open", json!({"ref": "x:1"}), 5, |r| r.len() == 1);
    assert_eq!(notified(&rx, Duration::from_millis(500)).len(), 1);
    engine.write("attention.raise", json!({"ref": "x:1", "reason": "again", "level": 2}), card()).unwrap();
    assert_eq!(notified(&rx, Duration::from_millis(500)).len(), 0);
}

#[test]
fn attention_is_raised_for_blocked_firings() {
    let (dir, engine, rx) = template_home();
    write(
        &dir.path().join("home"),
        &[
            ("sources/t/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY\n);\n"),
            ("sources/t/views/items.sql", "SELECT id FROM t.items"),
            ("sources/t/writes/add.sql", "INSERT INTO t.items (id) VALUES (:id)"),
            (
                "rules/t.json",
                r#"{"id": "t", "when": {"view": "t_items"}, "key": "{id}", "into": "attention.raise", "args": {"ref": "t:{id}", "reason": "x", "level": 1}, "max_per_hour": 1}"#,
            ),
        ],
    );
    until(&engine, "core_rules", json!({"rule": "t"}), 5, |r| r.len() == 1);
    engine.write("t.add", json!({"id": 1}), card()).unwrap();
    engine.write("t.add", json!({"id": 2}), card()).unwrap();
    let raised = until(&engine, "attention_open", json!({"ref": "core:t"}), 5, |r| r.len() == 1);
    assert_eq!(raised[0]["reason"], "max_per_hour 1 exceeded; blocked firing 2");
    assert_eq!(raised[0]["level"], 2);
    assert_eq!(notified(&rx, Duration::from_millis(500)).len(), 1);
}
