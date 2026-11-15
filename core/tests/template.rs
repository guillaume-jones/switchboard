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

#[test]
fn sessions_track_claude_hooks_and_interrupts() {
    let (_dir, engine, _rx) = template_home();
    let hook = |event: Value| {
        let mut payload = json!({"session_id": "s1", "cwd": "/tmp"});
        payload.as_object_mut().unwrap().extend(event.as_object().unwrap().clone());
        let params = json!({"payload": payload.to_string(), "host": "dev.zed.Zed", "entrypoint": "sdk-ts"});
        engine.write("sessions.claude_hook", params, card()).unwrap();
        engine.query("sessions_items", json!({"id": "s1"})).unwrap()[0]["status"].as_str().unwrap().to_string()
    };
    for (event, status) in [
        (json!({"hook_event_name": "SessionStart", "source": "startup"}), "ready"),
        (json!({"hook_event_name": "UserPromptSubmit", "prompt": "fix the build"}), "working"),
        (json!({"hook_event_name": "SessionStart", "source": "compact"}), "working"),
        (json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash"}), "needs_permission"),
        (json!({"hook_event_name": "PostToolUse", "tool_name": "Bash"}), "working"),
        (json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"}), "needs_input"),
        (json!({"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion"}), "working"),
        (json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"}), "working"),
        (json!({"hook_event_name": "Notification", "notification_type": "elicitation_dialog"}), "needs_input"),
        (json!({"hook_event_name": "StopFailure"}), "errored"),
        (json!({"hook_event_name": "Stop"}), "ready"),
        (json!({"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}), "ended"),
    ] {
        assert_eq!(hook(event.clone()), status, "after {event}");
    }
    let session = &engine.query("sessions_items", json!({"id": "s1"})).unwrap()[0];
    assert_eq!((session["title"].as_str(), session["host"].as_str()), (Some("fix the build"), Some("dev.zed.Zed")));
    assert_eq!(session["owned"], 0);

    let line = |kind: &str, text: &str| {
        json!({"type": kind, "sessionId": "s1", "message": {"role": kind, "content": [{"type": "text", "text": text}]}})
            .to_string()
    };
    hook(json!({"hook_event_name": "UserPromptSubmit"}));
    let interrupt = |line: String| engine.write("sessions.interrupted", json!({"line": line}), card()).unwrap();
    assert_eq!(interrupt(line("assistant", "[Request interrupted by user]")), 0);
    assert_eq!(interrupt(line("user", "[Request interrupted by user for tool use]")), 1);
    assert_eq!(engine.query("sessions_items", json!({"id": "s1"})).unwrap()[0]["status"], "ready");
    assert_eq!(interrupt(line("user", "[Request interrupted by user]")), 0);
}

#[test]
fn sessions_keep_the_last_message_and_pending_decisions() {
    let (_dir, engine, _rx) = template_home();
    let hook = |event: Value, run_id: Option<&str>| {
        let mut payload = json!({"session_id": "s1", "cwd": "/tmp"});
        payload.as_object_mut().unwrap().extend(event.as_object().unwrap().clone());
        let params = json!({"payload": payload.to_string(), "host": "switchboard", "entrypoint": "sdk-cli"});
        let origin = Origin { trigger: "swb".into(), run_id: run_id.map(String::from) };
        engine.write("sessions.claude_hook", params, origin).unwrap();
        engine.query("sessions_items", json!({"id": "s1"})).unwrap()[0].clone()
    };
    hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "investigate"}), Some("run1"));
    let session = hook(json!({"hook_event_name": "Stop", "last_assistant_message": "Found it."}), None);
    assert_eq!((session["last_message"].as_str(), session["run_id"].as_str()), (Some("Found it."), Some("run1")));
    assert_eq!(session["owned"], 1);
    let session = hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "again"}), Some("run2"));
    assert_eq!((session["last_message"].as_str(), session["run_id"].as_str()), (Some("Found it."), Some("run2")));
    assert_eq!((session["title"].as_str(), session["last_prompt"].as_str()), (Some("investigate"), Some("again")));

    let request = json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}});
    let session = hook(request, None);
    assert_eq!(session["status"], "needs_permission");
    let decision: Value = serde_json::from_str(session["decision"].as_str().unwrap()).unwrap();
    assert_eq!(decision["tool_input"], json!({"command": "ls"}));
    let decide = |at: &Value| {
        let params = json!({"id": "s1", "at": at, "answer": r#"{"behavior": "allow"}"#});
        engine.write("sessions.decide", params, card()).unwrap()
    };
    assert_eq!(decide(&json!(1)), 0, "an answer to another request is ignored");
    assert_eq!(decide(&decision["at"]), 1);
    let session = engine.query("sessions_items", json!({"id": "s1"})).unwrap()[0].clone();
    assert_eq!(session["answer"], r#"{"behavior":"allow"}"#);
    let session = hook(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash"}), None);
    assert_eq!((session["status"].as_str(), session["decision"].is_null(), session["answer"].is_null()), (Some("working"), true, true));
    let recent = |hidden: i64| engine.query("sessions.recent", json!({"limit": 10, "hidden": hidden})).unwrap().as_array().unwrap().len();
    assert_eq!((recent(0), recent(1)), (1, 0));
    engine.write("sessions.hide", json!({"id": "s1"}), card()).unwrap();
    assert_eq!((recent(0), recent(1)), (0, 1));
    engine.write("sessions.unhide", json!({"id": "s1"}), card()).unwrap();
    assert_eq!((recent(0), recent(1)), (1, 0));
}

#[test]
fn transcripts_keep_messages_of_open_sessions_only() {
    let (_dir, engine, _rx) = template_home();
    let add = |lines: Value| engine.write("sessions.transcript_add", json!({"payload": lines.to_string()}), card()).unwrap();
    let line = |uuid: &str, session: &str, kind: &str, content: Value| {
        json!({"uuid": uuid, "sessionId": session, "type": kind, "timestamp": format!("2026-01-01T00:00:0{uuid}Z"), "message": {"role": kind, "content": content}})
    };
    let first = line("1", "s1", "user", json!("hello"));
    assert_eq!(add(json!([first])), 0, "closed sessions keep nothing");
    engine.write("sessions.transcript_open", json!({"session": "s1"}), card()).unwrap();
    let mut sidechain = line("4", "s1", "assistant", json!([{"type": "text", "text": "subagent"}]));
    sidechain["isSidechain"] = json!(true);
    let lines = json!([
        first,
        line("2", "s1", "assistant", json!([{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "Hi"}, {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}])),
        line("3", "s2", "user", json!("other session")),
        sidechain,
        {"type": "queue-operation", "sessionId": "s1"},
    ]);
    assert_eq!(add(lines.clone()), 2);
    assert_eq!(add(lines), 0, "lines already kept are ignored");
    let messages = engine.query("sessions.transcript", json!({"session": "s1", "limit": 10})).unwrap();
    let texts: Vec<&str> = messages.as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["hello", "Hi\n\n→ Bash {\"command\":\"ls\"}"]);
    engine.write("sessions.transcript_close", json!({"session": "s1"}), card()).unwrap();
    assert_eq!(engine.query("sessions.transcript", json!({"session": "s1", "limit": 10})).unwrap(), json!([]));
}
