//! `data/swb.sock`: newline-delimited JSON requests from `swb`, and `data/spool/` for requests made while the
//! app was closed.

use crate::engine::{Event, Origin, Shared};
use anyhow::{Result, anyhow, bail};
use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;
use std::{fs, thread};

/// Replays the spool in order, then serves connections until the engine stops.
pub(crate) fn serve(shared: &Arc<Shared>, listener: UnixListener) {
    let spool = shared.home.join("data/spool");
    let mut spooled: Vec<_> = fs::read_dir(&spool).into_iter().flatten().flatten().map(|e| e.path()).collect();
    spooled.sort();
    for file in spooled.into_iter().filter(|f| f.extension().is_some_and(|e| e == "json")) {
        let request = fs::read_to_string(&file)
            .map_err(anyhow::Error::from)
            .and_then(|text| Ok(serde_json::from_str::<Value>(&text)?));
        if let Err(e) = request.and_then(|r| handle_request(shared, &r, "spool")) {
            shared.record(Event::error("spool", &file.to_string_lossy(), format!("{e:#}")));
        }
        let _ = fs::remove_file(file);
    }
    for stream in listener.incoming() {
        if shared.stopping.load(SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let shared = shared.clone();
        thread::spawn(move || serve_connection(&shared, stream));
    }
}

fn serve_connection(shared: &Shared, stream: UnixStream) {
    let mut writer = &stream;
    for line in BufReader::new(&stream).lines().map_while(Result::ok) {
        let request = serde_json::from_str::<Value>(&line).map_err(anyhow::Error::from);
        let response = match request.and_then(|r| handle_request(shared, &r, "swb")) {
            Ok(v) => Value::Object(Map::from_iter([("ok".into(), v)])),
            Err(e) => json!({ "error": format!("{e:#}") }),
        };
        if writeln!(writer, "{response}").is_err() {
            break;
        }
    }
}

/// `{"op": "write" | "query" | "run" | "finish" | "input" | "stop", ...}`, as sent by `swb`.
fn handle_request(shared: &Shared, request: &Value, trigger: &str) -> Result<Value> {
    let name = request["name"].as_str().unwrap_or_default();
    let mut params = request.get("params").cloned().unwrap_or(json!({}));
    if !params.is_object() && !params.is_null() {
        bail!("{name}: params must be a JSON object");
    }
    match request["op"].as_str() {
        Some("write") => {
            let takes_payload = shared.loaded().writers.get(name).is_some_and(|w| w.takes_payload());
            if takes_payload && params.get("payload").is_none() {
                let stdin = request["stdin"].as_str().ok_or_else(|| {
                    anyhow!("payload required: {name} takes :payload (pipe it on stdin, or pass payload=...)")
                })?;
                params["payload"] = stdin.into();
            }
            let origin = Origin { trigger: trigger.into(), run_id: request["run_id"].as_str().map(String::from) };
            Ok(shared.write(name, params, origin)?.into())
        }
        Some("query") => shared.query(name, params),
        Some("finish") => {
            let run_id = request["run_id"].as_str().ok_or_else(|| anyhow!("finish needs run_id"))?;
            let ok = request["ok"].as_bool().unwrap_or(false);
            shared.finish_run(run_id, ok, request["summary"].as_str()).map(|()| Value::Null)
        }
        Some("run") => {
            let origin = Origin { trigger: trigger.into(), run_id: request["run_id"].as_str().map(String::from) };
            shared.run(name, params, origin, None).map(Value::String)
        }
        Some("input") => {
            let run_id = request["run_id"].as_str().ok_or_else(|| anyhow!("input needs run_id"))?;
            let text =
                request["text"].as_str().or(request["stdin"].as_str()).ok_or_else(|| anyhow!("input needs text"))?;
            shared.input_run(run_id, text).map(|()| Value::Null)
        }
        Some("stop") => {
            let run_id = request["run_id"].as_str().ok_or_else(|| anyhow!("stop needs run_id"))?;
            shared.stop_run(run_id).map(|()| Value::Null)
        }
        op => bail!("unknown op {op:?} (expected write, query, run, finish, input, stop)"),
    }
}
