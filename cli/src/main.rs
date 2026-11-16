use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::time::SystemTime;
use std::{env, fs};
use switchboard_core::{Mode, Template, home, init, load};

const USAGE: &str = "usage:
  swb init [<git url> [--copy | -c]] [--force | -f]
      Replace the folder with the built-in template, or a git repo: kept linked to pull its updates,
      or copied into a new repo with --copy. Refuses a folder with work in it unless --force.
  swb check
      Validate the folder.
  swb write <source.writer> [name=value ...] [< payload]
      Call a writer. If the app is closed, the write is queued and applied on its next start.
  swb query <view | source.query> [name=value ...]
      Print the rows as a JSON array.
  swb run start <source.command> [name=value ...]
      Start a command by hand and print its run id. From a command, the new run is its child.
  swb run finish <run_id> --ok|--fail [summary]
      Finish an open run.
  swb run input <run_id> [text]
      Write a line, or stdin, to a long-running run's stdin.
  swb run stop <run_id>
      Stop a run: SIGTERM to its process group, SIGKILL 5s later. It ends as stopped.

Values that parse as JSON (4812, true, [1], {\"a\":1}) are passed as JSON, anything else as text.";

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
        ["init", rest @ ..] => {
            let flag = |names: [&str; 2]| rest.iter().any(|a| names.contains(a));
            let urls: Vec<&str> = rest.iter().copied().filter(|a| !a.starts_with('-')).collect();
            if urls.len() > 1
                || rest.len() - urls.len() > usize::from(flag(["--force", "-f"])) + usize::from(flag(["--copy", "-c"]))
            {
                return fail(USAGE, 2);
            }
            let template = match (urls.first(), flag(["--copy", "-c"])) {
                (None, _) => Template::BuiltIn,
                (Some(url), false) => Template::Linked(url),
                (Some(url), true) => Template::Copied(url),
            };
            return match init(&home, template, flag(["--force", "-f"])) {
                Ok(()) => {
                    println!("initialised {}", home.display());
                    ExitCode::SUCCESS
                }
                Err(e) => fail(format!("{e:#}"), 1),
            };
        }
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
        ["run", "start", name, rest @ ..] => match params(rest) {
            Ok(p) => json!({ "op": "run", "name": name, "params": p, "run_id": env::var("RUN_ID").ok() }),
            Err(e) => return fail(e, 2),
        },
        ["run", "input", id, text @ ..] => {
            let text = (!text.is_empty()).then(|| text.join(" "));
            json!({ "op": "input", "run_id": id, "text": text })
        }
        ["run", "stop", id] => json!({ "op": "stop", "run_id": id }),
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
    if request["op"] == "input" && request["text"].is_null() {
        match stdin() {
            Some(text) => request["text"] = text.into(),
            None => return fail("swb run input: give the text as arguments or on stdin", 2),
        }
    }
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
    match request["op"].as_str() {
        Some("query") => println!("{}", response["ok"]),
        Some("run") => println!("{}", response["ok"].as_str().unwrap_or_default()),
        _ => {}
    }
    ExitCode::SUCCESS
}
