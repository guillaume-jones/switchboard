use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};
use switchboard_core::{Emitter, Engine, Mode, Origin, load};

const SOURCES: usize = 20;
const ROWS: i64 = 10_000;

/// Subscription ids start at 1, so a `config` push (a reload) is reported as id 0.
const RELOADED: u64 = 0;

struct Pushes(Mutex<Sender<(Instant, u64)>>);

impl Emitter for Pushes {
    fn emit(&self, event: &str, payload: Value) {
        let id = match event {
            "rows" => payload["id"].as_u64().unwrap(),
            "config" => RELOADED,
            _ => return,
        };
        let _ = self.0.lock().unwrap().send((Instant::now(), id));
    }
}

fn generate(home: &Path) {
    for i in 0..SOURCES {
        let s = format!("s{i}");
        let dir = home.join("sources").join(&s);
        for sub in ["views", "queries", "writes"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let tables: String = (0..5)
            .map(|t| format!("CREATE TABLE t{t} (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  state TEXT,\n  n INTEGER,\n  raw TEXT\n);\nCREATE INDEX t{t}_state ON t{t} (state);\n"))
            .collect();
        let prev = format!("s{}", (i + SOURCES - 1) % SOURCES);
        let mut files = vec![("schema.sql".to_string(), tables)];
        for t in 0..5 {
            files.push((format!("views/t{t}.sql"), format!("SELECT id, title, state, n FROM {s}.t{t}")));
        }
        files.extend([
            ("views/items.sql".into(), format!("SELECT id, title FROM {s}.t0")),
            ("views/open.sql".into(), format!("SELECT id, title, n FROM {s}.t1 WHERE state = 'open'")),
            ("views/cross.sql".into(), format!("SELECT a.id, a.title, b.n FROM {s}.t2 a JOIN {prev}_t2 b ON b.id = a.id")),
            ("queries/search.sql".into(), format!("SELECT id, title FROM {s}.t0 WHERE title LIKE :text LIMIT 50")),
            ("queries/page.sql".into(), format!("SELECT id, title FROM {s}_cross ORDER BY id LIMIT :limit OFFSET :offset")),
            ("queries/count.sql".into(), format!("SELECT count(*) AS n FROM {s}.t3 WHERE state = :state")),
            (
                "writes/upsert.sql".into(),
                format!(
                    "INSERT INTO {s}.t0 (id, title, state, n, raw)\nSELECT :payload ->> '$.id', :payload ->> '$.title', :payload ->> '$.state', :payload ->> '$.n', :payload WHERE true\nON CONFLICT (id) DO UPDATE SET title = excluded.title, state = excluded.state, n = excluded.n, raw = excluded.raw"
                ),
            ),
            ("writes/set_state.sql".into(), format!("UPDATE {s}.t1 SET state = :state WHERE id = :id")),
            ("writes/bump.sql".into(), format!("UPDATE {s}.t2 SET n = n + 1 WHERE id = :id")),
            ("writes/delete.sql".into(), format!("DELETE FROM {s}.t4 WHERE id = :id")),
        ]);
        for (rel, text) in files {
            fs::write(dir.join(rel), text).unwrap();
        }
    }
    load(home, Mode::Apply).unwrap();
    for i in 0..SOURCES {
        let db = rusqlite::Connection::open(home.join(format!("data/s{i}.db"))).unwrap();
        db.execute_batch("BEGIN").unwrap();
        for t in 0..5 {
            db.execute(
                &format!(
                    "WITH RECURSIVE k(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM k WHERE id < {ROWS})
                     INSERT INTO t{t} (id, title, state, n, raw) SELECT id, 'item ' || id, CASE WHEN id % 100 = 0 THEN 'open' ELSE 'closed' END, id, '{{}}' FROM k"
                ),
                [],
            )
            .unwrap();
        }
        db.execute_batch("COMMIT").unwrap();
    }
}

fn stats(name: &str, mut samples: Vec<Duration>) {
    samples.sort();
    let at = |p: f64| samples[((samples.len() - 1) as f64 * p) as usize].as_secs_f64() * 1000.0;
    println!(
        "{name:<44} p50 {:>8.2} ms   p99 {:>8.2} ms   max {:>8.2} ms   (n={})",
        at(0.5),
        at(0.99),
        at(1.0),
        samples.len()
    );
}

fn wait(rx: &Receiver<(Instant, u64)>, mut ids: Vec<u64>, start: Instant) -> Vec<(u64, Duration)> {
    let mut out = Vec::new();
    while !ids.is_empty() {
        let (at, id) = rx.recv_timeout(Duration::from_secs(5)).expect("push");
        if let Some(i) = ids.iter().position(|x| *x == id) {
            ids.remove(i);
            out.push((id, at - start));
        }
    }
    out
}

fn main() {
    let home = std::env::temp_dir().join(format!("switchboard-bench-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    let t = Instant::now();
    generate(&home);
    println!(
        "generated {SOURCES} sources, 100 tables x {ROWS} rows, 300 SQL files in {:.1} s",
        t.elapsed().as_secs_f64()
    );

    stats(
        "load(Check)              target < 250 ms",
        (0..20)
            .map(|_| {
                let t = Instant::now();
                load(&home, Mode::Check).unwrap();
                t.elapsed()
            })
            .collect(),
    );
    stats(
        "load(Apply), no changes  target < 250 ms",
        (0..20)
            .map(|_| {
                let t = Instant::now();
                load(&home, Mode::Apply).unwrap();
                t.elapsed()
            })
            .collect(),
    );
    fs::create_dir_all(home.join("cards/lib")).unwrap();
    for i in 0..10 {
        let lib = format!(
            "export const plural{i} = (n: number, word: string): string => `${{n}} ${{word}}${{n === 1 ? \"\" : \"s\"}}`\n"
        );
        fs::write(home.join(format!("cards/lib/f{i}.ts")), lib).unwrap();
    }
    for i in 0..50 {
        let card = format!(
            "import {{ plural{0} }} from \"./lib/f{0}\"\n{1}",
            i % 10,
            include_str!("../../template/cards/Health.tsx")
        );
        fs::write(home.join(format!("cards/C{i}.tsx")), card).unwrap();
    }
    stats(
        "load(Check), + 50 cards and 10 lib files",
        (0..20)
            .map(|_| {
                let t = Instant::now();
                load(&home, Mode::Check).unwrap();
                t.elapsed()
            })
            .collect(),
    );
    fs::remove_dir_all(home.join("cards")).unwrap();
    stats(
        "Engine::open             target < 300 ms",
        (0..10)
            .map(|_| {
                let t = Instant::now();
                let e = Engine::open(&home, Pushes(Mutex::new(channel().0))).unwrap();
                let d = t.elapsed();
                drop(e);
                d
            })
            .collect(),
    );

    let (tx, rx) = channel();
    let engine = Engine::open(&home, Pushes(Mutex::new(tx))).unwrap();
    let t = Instant::now();
    let (open, rows) = engine.subscribe("s5_open", json!({})).unwrap();
    println!(
        "first subscribe (opens a reader)             {:.2} ms, {} rows",
        t.elapsed().as_secs_f64() * 1000.0,
        rows.as_array().unwrap().len()
    );
    let (full, rows) = engine.subscribe("s5_t2", json!({})).unwrap();
    println!("subscribed s5_t2: {} rows", rows.as_array().unwrap().len());
    let origin = Origin { trigger: "bench".into(), run_id: None };
    let mut alone = Vec::new();
    for k in 0..100 {
        let start = Instant::now();
        engine.write("s5.bump", json!({"id": 1 + k}), origin.clone()).unwrap();
        alone.extend(wait(&rx, vec![full], start).into_iter().map(|(_, d)| d));
    }
    stats("write -> push, 10k-row result, sole subscriber", alone);
    let (cross, rows) = engine.subscribe("s6_cross", json!({})).unwrap();
    println!("subscribed s6_cross: {} rows (s6.t2 join s5_t2)", rows.as_array().unwrap().len());
    let (one, _) = engine.subscribe("s0_items", json!({"id": 5})).unwrap();
    let (search, _) = engine.subscribe("s0.search", json!({"text": "item 5%"})).unwrap();

    stats(
        "query, 10k-row view (full result)",
        (0..50)
            .map(|_| {
                let t = Instant::now();
                engine.query("s5_t2", json!({})).unwrap();
                t.elapsed()
            })
            .collect(),
    );
    stats(
        "query, 10k-row cross-source join",
        (0..50)
            .map(|_| {
                let t = Instant::now();
                engine.query("s6_cross", json!({})).unwrap();
                t.elapsed()
            })
            .collect(),
    );
    let mut small = Vec::new();
    for k in 0..300 {
        let start = Instant::now();
        let state = if (k / 99) % 2 == 0 { "open" } else { "closed" };
        engine.write("s5.set_state", json!({"id": 1 + k % 99, "state": state}), origin.clone()).unwrap();
        small.extend(wait(&rx, vec![open], start).into_iter().map(|(_, d)| d));
    }
    stats("write -> push, 100-row view over 10k rows   target < 5 ms", small);

    let (mut full_d, mut cross_d) = (Vec::new(), Vec::new());
    for k in 0..100 {
        let start = Instant::now();
        engine.write("s5.bump", json!({"id": 1 + k}), origin.clone()).unwrap();
        for (id, d) in wait(&rx, vec![full, cross], start) {
            if id == full { full_d.push(d) } else { cross_d.push(d) }
        }
    }
    stats("write -> push, 10k-row view (full result)", full_d);
    stats("write -> push, 10k-row cross-source join", cross_d);

    let payload = |k: i64| json!({"payload": {"id": k, "title": format!("session {k}"), "state": "working", "n": k, "session_id": "6f1c2b9e-1d1e-4f7a-9d0b-4b6f0f9f2a11", "transcript_path": "/Users/me/.claude/projects/x/6f1c2b9e.jsonl", "cwd": "/Users/me/src/project", "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "cargo test -q", "description": "Run tests"}, "tool_response": {"stdout": "x".repeat(400), "stderr": "", "interrupted": false}}});
    while rx.try_recv().is_ok() {}
    let start = Instant::now();
    let total: i64 = 20_000;
    let latencies: Vec<Duration> = thread::scope(|s| {
        let handles: Vec<_> = (0..8i64)
            .map(|t| {
                let (engine, origin) = (&engine, origin.clone());
                s.spawn(move || {
                    (0..total / 8)
                        .map(|k| {
                            let w = Instant::now();
                            engine.write("s0.upsert", payload(ROWS + 1 + t * total + k), origin.clone()).unwrap();
                            w.elapsed()
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let secs = start.elapsed().as_secs_f64();
    println!(
        "burst: {total} hook payload writes from 8 threads: {:.0} writes/s   target >= 1000/s",
        total as f64 / secs
    );
    stats("burst write latency", latencies);

    let start = Instant::now();
    let mut paced = Vec::new();
    for k in 0..3000 {
        let due = start + Duration::from_micros(1000 * k as u64);
        thread::sleep(due.saturating_duration_since(Instant::now()));
        let w = Instant::now();
        engine.write("s0.upsert", payload(k as i64 % 1000 + 1), origin.clone()).unwrap();
        paced.push(w.elapsed());
    }
    println!("paced: 3000 writes at 1000/s finished {:.0} ms late", (start.elapsed().as_secs_f64() - 3.0) * 1000.0);
    stats("paced write latency (1000/s)", paced);
    let _ = (one, search);
    drop(engine);

    for (rel, text) in [
        ("sources/s0/views/hot.sql", "SELECT id, n FROM s0.t0 WHERE id <= 50"),
        ("sources/s0/writes/note.sql", "INSERT INTO s0.t3 (title) VALUES (:key)"),
        ("sources/s1/commands/noop", "#!/bin/sh\n"),
        (
            "rules/hot.json",
            r#"{"id": "hot", "when": {"view": "s0_hot"}, "key": "{id}@{n}", "into": "s0.note", "args": {"key": "{id}@{n}"}, "max_per_hour": 100000000}"#,
        ),
    ] {
        fs::create_dir_all(home.join(rel).parent().unwrap()).unwrap();
        fs::write(home.join(rel), text).unwrap();
    }
    std::process::Command::new("chmod").arg("+x").arg(home.join("sources/s1/commands/noop")).status().unwrap();
    let (tx, rx) = channel();
    let engine = Engine::open(&home, Pushes(Mutex::new(tx))).unwrap();
    thread::sleep(Duration::from_millis(500));
    let (hot, _) = engine.subscribe("s0_hot", json!({})).unwrap();
    let hook = |k: i64| {
        let mut p = payload(k % 50 + 1);
        p["payload"]["n"] = json!(1_000_000 + k);
        p
    };
    let mut pushed = Vec::new();
    for k in 0..200 {
        let start = Instant::now();
        engine.write("s0.upsert", hook(500_000 + k), origin.clone()).unwrap();
        pushed.extend(wait(&rx, vec![hot], start).into_iter().map(|(_, d)| d));
    }
    stats("rule firing per write: write -> push", pushed);
    let health = [
        ("core_events", json!({"kind": "error"})),
        ("core_rules", json!({"enabled": 0})),
        ("core_runs", json!({"state": "unknown"})),
    ];
    let mut mounted: Vec<u64> = health.iter().map(|(n, p)| engine.subscribe(n, p.clone()).unwrap().0).collect();
    let mut pushed = Vec::new();
    for k in 0..200 {
        let start = Instant::now();
        engine.write("s0.upsert", hook(600_000 + k), origin.clone()).unwrap();
        pushed.extend(wait(&rx, vec![hot], start).into_iter().map(|(_, d)| d));
    }
    stats("rule + Health card's 3 core reads: write -> push", pushed);
    let start = Instant::now();
    let mut paced = Vec::new();
    for k in 0..3000 {
        let due = start + Duration::from_micros(1000 * k as u64);
        thread::sleep(due.saturating_duration_since(Instant::now()));
        let w = Instant::now();
        engine.write("s0.upsert", hook(10_000 + k), origin.clone()).unwrap();
        paced.push(w.elapsed());
    }
    println!(
        "rule + Health mounted, paced: 3000 sequential writes at 1000/s finished {:.0} ms late",
        (start.elapsed().as_secs_f64() - 3.0) * 1000.0
    );
    stats("rule + Health mounted, paced write latency", paced);
    mounted.extend(
        [json!({"kind": "error"}), json!({"kind": "slow_read"}), json!({"run_id": "r0"})]
            .map(|f| engine.subscribe("core_events", f).unwrap().0),
    );
    while rx.try_recv().is_ok() {}
    let mut pushed = Vec::new();
    for k in 0..200 {
        let start = Instant::now();
        engine.write("s0.upsert", hook(k), origin.clone()).unwrap();
        pushed.extend(wait(&rx, vec![hot], start).into_iter().map(|(_, d)| d));
    }
    stats("+ 3 filtered core_events mounts: write -> push", pushed);
    let firings = |e: &Engine| loop {
        let n = e.query("core_firings", json!({"rule": "hot"})).unwrap().as_array().unwrap().len();
        thread::sleep(Duration::from_millis(200));
        if e.query("core_firings", json!({"rule": "hot"})).unwrap().as_array().unwrap().len() == n {
            break n;
        }
    };
    println!("rule fired {} times (once per new {{id}}@{{n}} key)", firings(&engine));
    let start = Instant::now();
    thread::scope(|s| {
        for t in 0..8i64 {
            let (engine, origin) = (&engine, origin.clone());
            s.spawn(move || {
                for k in 0..total / 8 {
                    engine.write("s0.upsert", hook(100_000 + t * total + k), origin.clone()).unwrap();
                }
            });
        }
    });
    println!("all mounted, burst: {:.0} writes/s from 8 threads", total as f64 / start.elapsed().as_secs_f64());
    println!("rule fired {} times in total (fewer: more writes coalesced per group commit)", firings(&engine));
    while rx.try_recv().is_ok() {}

    let (mut started, mut finished) = (Vec::new(), Vec::new());
    for _ in 0..100 {
        let start = Instant::now();
        let id = engine.run("s1.noop", json!({}), origin.clone()).unwrap();
        started.push(start.elapsed());
        while engine.query("core_runs", json!({"id": id, "state": "success"})).unwrap().as_array().unwrap().is_empty() {
            thread::sleep(Duration::from_micros(200));
        }
        finished.push(start.elapsed());
    }
    stats("engine.run() returns (run row committed)", started);
    stats("engine.run() -> trivial command exited, row success", finished);

    let mut reloads = Vec::new();
    for k in 0..10 {
        while rx.try_recv().is_ok() {}
        let start = Instant::now();
        fs::write(home.join("sources/s1/views/extra.sql"), format!("SELECT id, title FROM s1.t0 WHERE id > {k}"))
            .unwrap();
        reloads.extend(wait(&rx, vec![RELOADED], start).into_iter().map(|(_, d)| d));
    }
    stats("folder edit -> reload applied (100 ms debounce)", reloads);

    let swb = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("swb");
    if swb.exists() {
        let rounds: Vec<Duration> = (0..200)
            .map(|k| {
                let start = Instant::now();
                let ok = std::process::Command::new(&swb)
                    .args(["write", "s1.set_state", &format!("id={}", k + 1), "state=open"])
                    .env("SWITCHBOARD_HOME", &home)
                    .stdin(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                assert!(ok);
                start.elapsed()
            })
            .collect();
        stats("swb write round trip (process start to exit)", rounds);
    } else {
        println!("swb not built at {}: run cargo build --release -p switchboard-cli", swb.display());
    }
    let _ = mounted;
    drop(engine);
    let _ = fs::remove_dir_all(&home);
}
