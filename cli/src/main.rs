use switchboard_core::{Mode, home, load};
use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::time::SystemTime;
use std::{env, fs};

const USAGE: &str = "usage:
  swb check
  swb write <source.writer> [name=value ...] [< payload]
  swb query <view | source.query> [name=value ...]
  swb run finish <run_id> --ok|--fail [summary]

Named params are name=value arguments; a value that parses as JSON (4812, true, null, [1], {\"a\":1})
is passed as that JSON, anything else as text. swb write reads stdin only when the writer takes
:payload and no payload= argument is given; stdin is then bound to :payload. Otherwise stdin is never
read, so an open pipe cannot block it.
RUN_ID from the environment is forwarded, so writes made by a command belong to its run.
swb query prints the rows as a JSON array. If the app is not running, or closes the connection before
replying, swb write appends the request (with stdin, when it is not a terminal) to
$SWITCHBOARD_HOME/data/spool/ and the app replays it, in order, on its next start. Delivery is
at-least-once.";

fn fail(message: impl std::fmt::Display, code: u8) -> ExitCode {
    eprintln!("swb: {message}");
    ExitCode::from(code)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let home = home();
    let params = |rest: &[&str]| -> Result<Value, String> {
        let pairs = rest.iter().map(|a| {
            let (k, v) = a.split_once('=').ok_or(format!("expected name=value, got {a}"))?;
            Ok((k.to_string(), serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.into()))))
        });
        pairs.collect::<Result<Map<_, _>, String>>().map(Value::Object)
    };
    let mut request = match args.as_slice() {
        ["check"] => {
            return match load(&home, Mode::Check) {
                Ok(loaded) => {
                    for w in &loaded.warnings {
                        eprintln!("{w}");
                    }
                    println!(
                        "ok: {} sources, {} views, {} queries, {} writers, {} rules",
                        loaded.sources.len(),
                        loaded.views.len(),
                        loaded.queries.len(),
                        loaded.writers.len(),
                        loaded.rules.len()
                    );
                    ExitCode::SUCCESS
                }
                Err(diagnostics) => {
                    for d in &diagnostics {
                        eprintln!("{d}");
                    }
                    ExitCode::FAILURE
                }
            };
        }
        ["write", name, rest @ ..] => match params(rest) {
            Ok(p) => json!({ "op": "write", "name": name, "params": p, "run_id": env::var("RUN_ID").ok() }),
            Err(e) => return fail(e, 2),
        },
        ["query", name, rest @ ..] => match params(rest) {
            Ok(p) => json!({ "op": "query", "name": name, "params": p }),
            Err(e) => return fail(e, 2),
        },
        ["run", "finish", id, flag @ ("--ok" | "--fail"), summary @ ..] => {
            let summary = (!summary.is_empty()).then(|| summary.join(" "));
            json!({ "op": "finish", "run_id": id, "ok": *flag == "--ok", "summary": summary })
        }
        ["--help" | "-h" | "help"] => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => return fail(USAGE, 2),
    };
    let write = request["op"] == "write";
    let stdin = || {
        let mut text = String::new();
        let piped = !std::io::stdin().is_terminal() && std::io::stdin().read_to_string(&mut text).is_ok();
        (piped && !text.is_empty()).then_some(text)
    };
    let spool = |mut request: Value, why: &str| {
        if let Some(text) = stdin() {
            request["stdin"] = text.into();
        }
        let spool = home.join("data/spool");
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let file = spool.join(format!("{nanos:020}-{}.json", std::process::id()));
        match fs::create_dir_all(&spool).and_then(|_| fs::write(&file, request.to_string())) {
            Ok(()) => {
                eprintln!("swb: {why}; spooled to {}, the app replays it on start", file.display());
                ExitCode::SUCCESS
            }
            Err(e) => fail(format!("cannot spool: {e}"), 1),
        }
    };
    let stream = match UnixStream::connect(home.join("data/swb.sock")) {
        Ok(s) => s,
        Err(_) if write => return spool(request, "the app is not running"),
        Err(e) => return fail(format!("the app is not running ({e})"), 1),
    };
    let mut reader = BufReader::new(&stream);
    let mut send = |request: &Value| {
        let mut line = String::new();
        writeln!(&stream, "{request}").and_then(|_| reader.read_line(&mut line)).ok().filter(|n| *n > 0)?;
        serde_json::from_str::<Value>(&line).ok()
    };
    let mut response = send(&request);
    let needs_payload = |r: &Option<Value>| {
        r.as_ref().and_then(|r| r["error"].as_str()).is_some_and(|e| e.starts_with("payload required"))
    };
    if write && needs_payload(&response) {
        let Some(payload) = stdin() else {
            return fail(response.unwrap()["error"].as_str().unwrap_or_default(), 1);
        };
        request["params"]["payload"] = payload.into();
        response = send(&request);
    }
    let Some(response) = response else {
        if write {
            return spool(
                request,
                "the app closed the connection before replying (the write may already be applied: delivery is at-least-once)",
            );
        }
        return fail("no response from the app", 1);
    };
    if let Some(e) = response["error"].as_str() {
        return fail(e, 1);
    }
    if request["op"] == "query" {
        println!("{}", response["ok"]);
    }
    ExitCode::SUCCESS
}
