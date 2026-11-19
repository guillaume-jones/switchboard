use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use switchboard_core::{Emitter, Engine};

struct Quiet;

impl Emitter for Quiet {
    fn emit(&self, _: &str, _: Value) {}
}

fn home(extra: &[(&str, &str)]) -> tempfile::TempDir {
    // Commands run by an in-process engine find swb through this; newer Cargo moved test binaries away from it.
    static SWB: std::sync::Once = std::sync::Once::new();
    // SAFETY: engines, whose C code reads the environment, only start after a home() call has returned.
    SWB.call_once(|| unsafe { std::env::set_var("SWITCHBOARD_SWB", env!("CARGO_BIN_EXE_swb")) });
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
fn run_start_input_and_stop_reach_a_long_running_command() {
    let h = home(&[
        ("sources/prs/source.json", r#"{"long_running": ["serve"]}"#),
        (
            "sources/prs/commands/serve",
            "#!/bin/sh\nread -r args\nwhile read -r title; do \"$SWB\" write prs.add id=1 title=\"$title\"; done\n",
        ),
        (
            "sources/prs/commands/launch",
            "#!/bin/sh\n\"$SWB\" run start prs.serve name=x > \"$SWITCHBOARD_HOME/serve.id\"\n",
        ),
    ]);
    let engine = Engine::open(h.path(), Quiet).unwrap();
    let launch = engine.run("prs.launch", json!({}), switchboard_core::Origin::default()).unwrap();
    let id_file = h.path().join("serve.id");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(&id_file).is_ok_and(|id| id.ends_with('\n')) {
        assert!(Instant::now() < deadline, "swb run start printed no run id");
        std::thread::sleep(Duration::from_millis(20));
    }
    let serve = fs::read_to_string(&id_file).unwrap().trim().to_string();
    let run = engine.query("core_runs", json!({"id": serve})).unwrap();
    assert_eq!((run[0]["command"].as_str(), run[0]["parent"].as_str()), (Some("prs.serve"), Some(launch.as_str())));
    let input = swb(h.path(), &["run", "input", &serve, "from", "args"], None);
    assert!(input.status.success(), "{}", String::from_utf8_lossy(&input.stderr));
    let deadline = Instant::now() + Duration::from_secs(5);
    while rows(h.path(), "prs_items") != json!([{"id": 1, "title": "from args"}]) {
        assert!(Instant::now() < deadline, "the input line never arrived");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(swb(h.path(), &["run", "stop", &serve], None).status.success());
    let deadline = Instant::now() + Duration::from_secs(10);
    while engine.query("core_runs", json!({"id": serve, "state": "stopped"})).unwrap().as_array().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the run was not stopped");
        std::thread::sleep(Duration::from_millis(20));
    }
    let late = swb(h.path(), &["run", "input", &serve], Some("late"));
    assert!(String::from_utf8_lossy(&late.stderr).contains("not running"), "{}", String::from_utf8_lossy(&late.stderr));
}

#[test]
fn pty_runs_serve_a_terminal_to_every_client() {
    let h = home(&[
        ("sources/prs/source.json", r#"{"pty": ["shell"]}"#),
        (
            "sources/prs/commands/shell",
            "#!/bin/sh\nstty -echo\necho ready \"$SWB_ARG_NAME\"\nwhile read -r line; do echo \"got $line $(stty size)\"; done\n",
        ),
    ]);
    let engine = Engine::open(h.path(), Quiet).unwrap();
    let id = engine.run("prs.shell", json!({"name": "t1"}), switchboard_core::Origin::default()).unwrap();
    let read_until = |pty: &mut switchboard_core::Pty, text: &str| {
        let (mut seen, mut buf) = (String::new(), [0u8; 4096]);
        while !seen.contains(text) {
            let n = std::io::Read::read(pty, &mut buf).unwrap();
            assert!(n > 0, "the terminal closed before {text:?}; got {seen:?}");
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        seen
    };
    let mut first = engine.pty(&id).unwrap();
    read_until(&mut first, "ready t1");
    first.resize(100, 30).unwrap();
    first.input(b"hello\n").unwrap();
    read_until(&mut first, "got hello 30 100");
    let mut second = engine.pty(&id).unwrap();
    read_until(&mut second, "got hello 30 100");
    first.close();
    second.input(b"again\n").unwrap();
    read_until(&mut second, "got again");
    engine.stop_run(&id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while engine.query("core_runs", json!({"id": id, "state": "stopped"})).unwrap().as_array().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the run was not stopped");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(format!("{:#}", engine.pty(&id).err().unwrap()).contains("ended"));
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

#[test]
#[cfg(target_os = "macos")]
#[cfg_attr(debug_assertions, ignore = "only release builds use LTO; run with cargo test --release")]
fn swb_loads_no_frameworks() {
    let out = Command::new("otool").arg("-L").arg(env!("CARGO_BIN_EXE_swb")).output().unwrap();
    let libraries = String::from_utf8_lossy(&out.stdout);
    assert!(
        !libraries.contains(".framework"),
        "swb links a framework, adding ~1 ms to every hook: its code reaches into the engine\n{libraries}"
    );
}

#[test]
fn init_replaces_only_an_untouched_folder_unless_forced() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("folder");
    let git = |cwd: &Path, args: &[&str]| {
        let identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
        assert!(Command::new("git").current_dir(cwd).args(identity).args(args).output().unwrap().status.success());
    };
    let stderr = |out: Output| String::from_utf8_lossy(&out.stderr).into_owned();

    assert!(swb(&folder, &["init"], None).status.success());
    assert!(folder.join("settings.json").is_file());
    let hooks_path = Command::new("git").current_dir(&folder).args(["config", "core.hooksPath"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&hooks_path.stdout), ".githooks\n");
    assert_eq!(fs::metadata(folder.join(".githooks/pre-commit")).unwrap().permissions().mode() & 0o111, 0o111);
    assert!(swb(&folder, &["init"], None).status.success());

    fs::write(folder.join("settings.json"), "{}").unwrap();
    assert!(stderr(swb(&folder, &["init"], None)).contains("pass --force"));

    let template = dir.path().join("template");
    fs::create_dir(&template).unwrap();
    fs::write(template.join("settings.json"), r#"{"remote": null}"#).unwrap();
    git(&template, &["init", "-q"]);
    git(&template, &["add", "-A"]);
    git(&template, &["commit", "-q", "-m", "template"]);
    assert!(swb(&folder, &["init", template.to_str().unwrap(), "-f"], None).status.success());
    assert_eq!(fs::read_to_string(folder.join("settings.json")).unwrap(), r#"{"remote": null}"#);
    assert!(!folder.join("cards").exists());
    let log = Command::new("git").current_dir(&folder).args(["log", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout), "template\n");

    assert!(swb(&folder, &["init", "-c", template.to_str().unwrap(), "--force"], None).status.success());
    let log = Command::new("git").current_dir(&folder).args(["log", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout), "Initial switchboard folder\n");
    let remotes = Command::new("git").current_dir(&folder).arg("remote").output().unwrap();
    assert!(remotes.stdout.is_empty());
    assert_eq!(fs::read_to_string(folder.join(".gitignore")).unwrap(), "data/\ncards/switchboard.d.ts\n");
    assert!(swb(&folder, &["init", template.to_str().unwrap(), "--copy"], None).status.success());

    let _engine = Engine::open(&folder, Quiet).unwrap();
    assert!(stderr(swb(&folder, &["init", "--force"], None)).contains("quit it first"));
}
