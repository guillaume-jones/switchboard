use switchboard_core::{Emitter, Engine, Origin};
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
        fs::write(path, text).unwrap();
    }
}

const FILES: &[(&str, &str)] = &[
    ("sources/prs/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  state TEXT\n);\n"),
    ("sources/prs/views/items.sql", "SELECT id, title, state FROM prs.items"),
    (
        "sources/prs/writes/upsert.sql",
        "INSERT INTO prs.items (id, title, state) VALUES (:id, :title, :state)\nON CONFLICT (id) DO UPDATE SET title = excluded.title, state = excluded.state",
    ),
    ("sources/prs/queries/search.sql", "SELECT id, title FROM prs.items WHERE title LIKE :text ORDER BY id"),
    (
        "sources/board/schema.sql",
        "CREATE TABLE pins (\n  pr INTEGER PRIMARY KEY\n);\nCREATE TABLE notes (\n  id INTEGER PRIMARY KEY,\n  body TEXT\n);\n",
    ),
    (
        "sources/board/views/pinned.sql",
        "WITH p AS (SELECT pr FROM board.pins) SELECT i.id, i.title FROM p JOIN prs_items i ON i.id = p.pr",
    ),
    ("sources/board/views/notes.sql", "SELECT id, body FROM board.notes"),
    ("sources/board/writes/pin.sql", "INSERT OR IGNORE INTO board.pins (pr) VALUES (:pr)"),
    ("sources/board/writes/note.sql", "INSERT INTO board.notes (body) VALUES (:body)"),
    ("sources/feed/views/top.sql", "SELECT id, title FROM board_pinned"),
];

fn open() -> (tempfile::TempDir, Engine, Receiver<(String, Value)>) {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), FILES);
    let (tx, rx) = channel();
    let engine = Engine::open(dir.path(), Events(Mutex::new(tx))).unwrap();
    (dir, engine, rx)
}

fn card() -> Origin {
    Origin { trigger: "card".into(), run_id: None }
}

fn pushes(rx: &Receiver<(String, Value)>, wait: Duration) -> Vec<(String, Value)> {
    let deadline = Instant::now() + wait;
    let mut out = Vec::new();
    while let Ok(e) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        out.push(e);
    }
    out
}

#[test]
fn write_pushes_to_dependent_cross_source_subscription_only() {
    let (_dir, engine, rx) = open();
    let (top, rows) = engine.subscribe("feed_top", json!({})).unwrap();
    assert_eq!(rows, json!([]));
    let (notes, _) = engine.subscribe("board_notes", json!({})).unwrap();
    assert_eq!(engine.write("prs.upsert", json!({"id": 1, "title": "Fix CI", "state": "open"}), card()).unwrap(), 1);
    assert_eq!(engine.write("board.pin", json!({"pr": 1}), card()).unwrap(), 1);
    let got = pushes(&rx, Duration::from_millis(300));
    let rows: Vec<&Value> = got.iter().filter(|(e, _)| e == "rows").map(|(_, p)| p).collect();
    assert!(rows.iter().all(|p| p["id"] == top), "{rows:?}");
    assert_eq!(rows.last().unwrap()["rows"], json!([{"id": 1, "title": "Fix CI"}]));

    engine.write("prs.upsert", json!({"id": 1, "title": "Fix CI", "state": "open"}), card()).unwrap();
    engine.write("prs.upsert", json!({"id": 2, "title": "Other", "state": "open"}), card()).unwrap();
    assert!(pushes(&rx, Duration::from_millis(300)).is_empty(), "unchanged result must not be pushed");

    engine.write("prs.upsert", json!({"id": 1, "title": "Fix CI now", "state": "open"}), card()).unwrap();
    let got = pushes(&rx, Duration::from_millis(300));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1["rows"], json!([{"id": 1, "title": "Fix CI now"}]));

    engine.write("board.note", json!({"body": "hi"}), card()).unwrap();
    let got = pushes(&rx, Duration::from_millis(300));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1["id"], notes);
}

#[test]
fn filters_queries_shared_subscriptions_and_param_errors() {
    let (_dir, engine, rx) = open();
    for (id, state) in [(1, "open"), (2, "closed"), (3, "open")] {
        engine.write("prs.upsert", json!({"id": id, "title": format!("pr {id}"), "state": state}), card()).unwrap();
    }
    assert_eq!(
        engine.query("prs_items", json!({"state": "open", "id": 3})).unwrap(),
        json!([{"id": 3, "title": "pr 3", "state": "open"}])
    );
    assert_eq!(engine.query("prs.search", json!({"text": "pr 2"})).unwrap(), json!([{"id": 2, "title": "pr 2"}]));
    assert!(
        engine
            .query("prs_items", json!({"nope": 1}))
            .unwrap_err()
            .to_string()
            .contains("unknown param :nope (expects :id, :title, :state)")
    );
    assert!(engine.query("prs.search", json!({})).unwrap_err().to_string().contains("missing param :text"));
    assert!(
        engine.write("prs.upsert", json!({"id": 9}), card()).unwrap_err().to_string().contains("missing param :title")
    );
    assert!(engine.query("prs.upsert", json!({})).unwrap_err().to_string().contains("it is a writer"));

    let (a, _) = engine.subscribe("prs_items", json!({"state": "open"})).unwrap();
    let (b, rows) = engine.subscribe("prs_items", json!({"state": "open"})).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    engine.unsubscribe(a);
    engine.write("prs.upsert", json!({"id": 2, "title": "pr 2", "state": "open"}), card()).unwrap();
    let got = pushes(&rx, Duration::from_millis(300));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1["id"], b);
    assert_eq!(got[0].1["rows"].as_array().unwrap().len(), 3);
}

#[test]
fn writes_and_errors_are_logged_to_events() {
    let (_dir, engine, _rx) = open();
    let run = Origin { trigger: "swb".into(), run_id: Some("r1".into()) };
    engine.write("prs.upsert", json!({"id": 1, "title": "x", "state": "open"}), run).unwrap();
    assert!(engine.write("prs.nope", json!({}), card()).is_err());
    let _ = engine.query("prs_nope", json!({}));
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut errors = loop {
        let errors = engine.query("core_events", json!({"kind": "error"})).unwrap().as_array().unwrap().clone();
        if errors.len() >= 2 || Instant::now() > deadline {
            break errors;
        }
    };
    errors.sort_by_key(|e| e["id"].as_i64());
    let summary: Vec<(&str, &str)> =
        errors.iter().map(|e| (e["name"].as_str().unwrap(), e["trigger"].as_str().unwrap())).collect();
    assert_eq!(summary, [("prs.nope", "card"), ("prs_nope", "query")]);
    let writes = engine.query("core_events", json!({"kind": "write"})).unwrap();
    assert_eq!(
        (writes[0]["name"].as_str(), writes[0]["trigger"].as_str(), writes[0]["run_id"].as_str()),
        (Some("prs.upsert"), Some("swb"), Some("r1"))
    );
}

#[test]
fn editing_a_lib_file_reloads_every_card_that_imports_it() {
    let (dir, engine, rx) = open();
    write(
        dir.path(),
        &[
            ("cards/A.tsx", "import { n } from \"./lib/n\"\nexport default () => n\n"),
            ("cards/B.tsx", "import { m } from \"./lib/m\"\nexport default () => m\n"),
            ("cards/C.tsx", "export default () => 0\n"),
            ("cards/lib/m.ts", "export { n as m } from \"./n\"\n"),
            ("cards/lib/n.ts", "export const n = 1\n"),
        ],
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !engine.config()["cards"].as_array().unwrap().contains(&json!("C")) {
        std::thread::sleep(Duration::from_millis(20));
    }
    pushes(&rx, Duration::from_millis(300));
    write(dir.path(), &[("cards/lib/n.ts", "export const n = 2\n")]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut cards = Vec::new();
    while Instant::now() < deadline && cards.len() < 2 {
        cards.extend(pushes(&rx, Duration::from_millis(300)).into_iter().filter(|(e, _)| e == "card").map(|(_, p)| p));
    }
    assert_eq!(cards, [json!({"name": "A"}), json!({"name": "B"})]);
    for card in ["A", "B"] {
        assert!(engine.card(card).unwrap()["lib/n.ts"].as_str().unwrap().contains('2'), "{card} is stale");
    }
}

#[test]
fn broken_edit_keeps_last_good_state_and_fix_reloads() {
    let (dir, engine, rx) = open();
    engine.write("prs.upsert", json!({"id": 1, "title": "x", "state": "open"}), card()).unwrap();
    let (id, _) = engine.subscribe("prs_items", json!({})).unwrap();
    write(dir.path(), &[("sources/prs/views/items.sql", "SELECT id, title, state, nope FROM prs.items")]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let errors = loop {
        let errors = engine.query("core_events", json!({"kind": "error"})).unwrap();
        if !errors.as_array().unwrap().is_empty() || Instant::now() > deadline {
            break errors;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let error = errors
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"].as_str().unwrap().starts_with("sources/prs/views/items.sql:"))
        .expect("error for the edited file");
    assert!(error["message"].as_str().unwrap().contains("no such column: nope"), "{errors}");
    assert_eq!(engine.query("prs_items", json!({})).unwrap(), json!([{"id": 1, "title": "x", "state": "open"}]));
    engine.write("prs.upsert", json!({"id": 2, "title": "y", "state": "open"}), card()).unwrap();

    write(
        dir.path(),
        &[
            (
                "sources/prs/schema.sql",
                "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  state TEXT,\n  url TEXT\n);\n",
            ),
            ("sources/prs/views/items.sql", "SELECT id, title, state, url FROM prs.items"),
        ],
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    let with_url = |(e, p): &&(String, Value)| e == "rows" && p["id"] == id && p["rows"][0].get("url").is_some();
    while Instant::now() < deadline && !seen.iter().any(|x| with_url(&x)) {
        seen.extend(pushes(&rx, Duration::from_millis(50)));
    }
    let rows = seen.iter().find(with_url).expect("rows pushed after reload");
    assert_eq!(rows.1["rows"][1], json!({"id": 2, "title": "y", "state": "open", "url": null}));
    assert!(seen.iter().any(|(e, _)| e == "config"));
}
