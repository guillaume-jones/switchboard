use switchboard_core::{Emitter, Engine};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Quiet;

impl Emitter for Quiet {
    fn emit(&self, _: &str, _: Value) {}
}

fn home(extra: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let base = [
        ("sources/prs/schema.sql", "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT\n);\n"),
        ("sources/prs/views/items.sql", "SELECT id, title FROM prs.items"),
        ("sources/prs/views/next.sql", "SELECT id, id + 1 AS next FROM prs.items"),
        ("sources/prs/writes/add.sql", "INSERT OR IGNORE INTO prs.items (id, title) VALUES (:id, :title)"),
        (
            "sources/prs/writes/hook.sql",
            "INSERT INTO prs.items (id, title) VALUES (:payload ->> '$.id', :payload ->> '$.title')",
        ),
    ];
    for (path, text) in base.iter().chain(extra) {
        let path = dir.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
}

fn swb(home: &Path, args: &[&str], stdin: Option<&str>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_swb"))
        .args(args)
        .env("SWITCHBOARD_HOME", home)
        .env_remove("RUN_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.unwrap_or_default().as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn rows(home: &Path, name: &str) -> Value {
    let out = swb(home, &["query", name], None);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn socket_round_trip_with_params_and_payload() {
    let h = home(&[]);
    let _engine = Engine::open(h.path(), Quiet).unwrap();
    assert!(swb(h.path(), &["write", "prs.add", "id=4812", "title=Fix CI"], None).status.success());
    assert!(swb(h.path(), &["write", "prs.hook"], Some(r#"{"id": 7, "title": "from stdin"}"#)).status.success());
    assert_eq!(rows(h.path(), "prs_items"), json!([{"id": 7, "title": "from stdin"}, {"id": 4812, "title": "Fix CI"}]));
    let out = swb(h.path(), &["query", "prs_items", "id=4812"], None);
    assert_eq!(serde_json::from_slice::<Value>(&out.stdout).unwrap(), json!([{"id": 4812, "title": "Fix CI"}]));
    let bad = swb(h.path(), &["write", "prs.add", "id=1"], None);
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("missing param :title"));
    let finish = swb(h.path(), &["run", "finish", "nope", "--ok", "done"], None);
    assert!(String::from_utf8_lossy(&finish.stderr).contains("run nope is not running or open"));
}

#[test]
fn spool_is_replayed_in_order_on_start() {
    let h = home(&[]);
    for (id, title) in [(1, "a"), (2, "b"), (3, "c")] {
        let out = swb(h.path(), &["write", "prs.add", &format!("id={id}"), &format!("title={title}")], None);
        assert!(String::from_utf8_lossy(&out.stderr).contains("spooled"), "{out:?}");
    }
    swb(h.path(), &["write", "prs.hook"], Some(r#"{"id": 1, "title": "duplicate"}"#));
    let engine = Engine::open(h.path(), Quiet).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.query("prs_items", json!({})).unwrap().as_array().unwrap().len() < 3 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        engine.query("prs_items", json!({})).unwrap(),
        json!([{"id": 1, "title": "a"}, {"id": 2, "title": "b"}, {"id": 3, "title": "c"}])
    );
    let errors = engine.query("core_events", json!({"kind": "error"})).unwrap();
    assert!(
        errors[0]["message"].as_str().unwrap().contains("UNIQUE constraint failed"),
        "the 4th, conflicting write was replayed last: {errors}"
    );
    assert_eq!(fs::read_dir(h.path().join("data/spool")).unwrap().count(), 0);
}

#[test]
fn lineage_through_swb_write_limits_depth() {
    let h = home(&[
        ("settings.json", r#"{"max_depth": 3}"#),
        ("sources/prs/commands/relay", "#!/bin/sh\nswb write prs.add id=$SWB_ARG_ID title=relayed\n"),
        (
            "rules/relay.json",
            r#"{"id": "relay", "when": {"view": "prs_next"}, "key": "{id}", "run": "prs.relay", "args": {"id": "{next}"}}"#,
        ),
    ]);
    let engine = Engine::open(h.path(), Quiet).unwrap();
    assert!(swb(h.path(), &["write", "prs.add", "id=1", "title=start"], None).status.success());
    let deadline = Instant::now() + Duration::from_secs(10);
    let firings = loop {
        let f = engine.query("core_firings", json!({"rule": "relay"})).unwrap();
        if f.as_array().unwrap().iter().any(|f| f["blocked"].is_string()) {
            break f;
        }
        assert!(Instant::now() < deadline, "{f}");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(firings.as_array().unwrap().len(), 4);
    let runs = engine.query("core_runs", json!({"rule": "relay"})).unwrap();
    let mut chain: Vec<(i64, Value, Value)> = runs
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["depth"].as_i64().unwrap(), r["id"].clone(), r["parent"].clone()))
        .collect();
    chain.sort_by_key(|c| c.0);
    assert_eq!(chain.iter().map(|c| c.0).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(chain[0].2, Value::Null);
    assert_eq!(chain[1].2, chain[0].1);
    assert_eq!(chain[2].2, chain[1].1);
    let writes = engine.query("core_events", json!({"kind": "write", "run_id": chain[0].1.clone()})).unwrap();
    assert_eq!(writes[0]["trigger"], "swb");
}

#[test]
fn write_never_reads_stdin_unless_the_writer_takes_a_payload() {
    let h = home(&[]);
    let engine = Engine::open(h.path(), Quiet).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_swb"))
        .args(["write", "prs.add", "id=1", "title=x"])
        .env("SWITCHBOARD_HOME", h.path())
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _open_pipe = child.stdin.take();
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if started.elapsed() > Duration::from_secs(10) {
            child.kill().unwrap();
            panic!("swb write blocked on an open stdin pipe: {:?}", child.wait_with_output());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    assert_eq!(engine.query("prs_items", json!({})).unwrap(), json!([{"id": 1, "title": "x"}]));
    let out = swb(h.path(), &["write", "prs.hook"], None);
    assert!(String::from_utf8_lossy(&out.stderr).contains("payload required"), "{out:?}");
}

#[test]
fn a_connection_dropped_before_the_reply_spools_the_write() {
    let h = home(&[]);
    fs::create_dir_all(h.path().join("data")).unwrap();
    let socket = h.path().join("data/swb.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut line);
        }
    });
    let out = swb(h.path(), &["write", "prs.hook"], Some(r#"{"id": 5, "title": "kept"}"#));
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("at-least-once"), "{out:?}");
    let _ = std::os::unix::net::UnixStream::connect(&socket);
    server.join().unwrap();
    fs::remove_file(&socket).unwrap();
    let engine = Engine::open(h.path(), Quiet).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.query("prs_items", json!({})).unwrap() != json!([{"id": 5, "title": "kept"}]) {
        assert!(Instant::now() < deadline, "spooled write was not replayed");
        std::thread::sleep(Duration::from_millis(20));
    }
}
