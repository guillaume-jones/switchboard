use switchboard_core::{Diagnostic, Level, Loaded, Mode, load};
use std::fs;
use std::path::Path;

fn write(home: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let path = home.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

fn home(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), files);
    dir
}

#[track_caller]
fn errors(home: &Path) -> String {
    match load(home, Mode::Check) {
        Ok(_) => panic!("expected errors"),
        Err(d) => d.iter().filter(|d| d.is_error()).map(Diagnostic::to_string).collect::<Vec<_>>().join("\n"),
    }
}

fn ok(home: &Path, mode: Mode) -> Loaded {
    load(home, mode)
        .unwrap_or_else(|d| panic!("{}", d.iter().map(Diagnostic::to_string).collect::<Vec<_>>().join("\n")))
}

const PRS: &[(&str, &str)] = &[
    (
        "sources/prs/schema.sql",
        "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  ci_state TEXT -- @deprecated use ci_status\n);\n",
    ),
    ("sources/prs/views/items.sql", "SELECT id, title FROM prs.items"),
    (
        "sources/prs/writes/upsert.sql",
        "INSERT INTO prs.items (id, title) VALUES (:id, :title)\nON CONFLICT (id) DO UPDATE SET title = excluded.title",
    ),
];

#[test]
fn core_and_simple_source_load() {
    let h = home(PRS);
    let l = ok(h.path(), Mode::Check);
    assert!(["core.timeline", "core.events", "core.runs"].iter().all(|q| l.queries.contains_key(*q)));
    assert!(l.writers.contains_key("core.rule_enable"));
    assert_eq!(l.views["prs_items"].columns, ["id", "title"]);
    assert_eq!(l.views["prs_items"].tables.iter().collect::<Vec<_>>(), ["prs.items"]);
    assert_eq!(l.writers["prs.upsert"].statements[0].params, ["id", "title"]);
    assert!(!h.path().join("data").exists(), "check mode must not touch disk");
}

#[test]
fn additive_schema_changes_apply_and_destructive_ones_are_refused() {
    let h = home(PRS);
    ok(h.path(), Mode::Apply);
    write(
        h.path(),
        &[(
            "sources/prs/schema.sql",
            "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  ci_state TEXT, -- @deprecated use ci_status\n  ci_status TEXT NOT NULL DEFAULT 'none' CHECK (ci_status IN ('none', 'ok'))\n);\nCREATE INDEX items_title ON items (title);\nCREATE TABLE dismissed (id INTEGER PRIMARY KEY);\n",
        )],
    );
    ok(h.path(), Mode::Check);
    ok(h.path(), Mode::Apply);
    let db = rusqlite::Connection::open(h.path().join("data/prs.db")).unwrap();
    let cols: Vec<String> = db
        .prepare("SELECT name FROM pragma_table_info('items')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(cols, ["id", "title", "ci_state", "ci_status"]);
    let objects: i64 = db
        .query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('dismissed', 'items_title')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(objects, 2);
    assert!(
        db.execute("INSERT INTO items (id, ci_status) VALUES (1, 'bad')", []).is_err(),
        "CHECK constraint kept on added column"
    );

    write(
        h.path(),
        &[(
            "sources/prs/schema.sql",
            "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT\n);\nCREATE TABLE dismissed (id INTEGER PRIMARY KEY);\n",
        )],
    );
    let e = errors(h.path());
    assert!(e.contains("column items.ci_state was removed or renamed"), "{e}");

    write(
        h.path(),
        &[(
            "sources/prs/schema.sql",
            "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title INTEGER,\n  ci_state TEXT,\n  ci_status TEXT NOT NULL DEFAULT 'none' CHECK (ci_status IN ('none', 'ok'))\n);\n",
        )],
    );
    let e = errors(h.path());
    assert!(e.contains("column items.title changed from `TEXT` to `INTEGER`"), "{e}");
    assert!(e.contains("table dismissed exists in the database but not in schema.sql"), "{e}");

    write(
        h.path(),
        &[(
            "sources/prs/schema.sql",
            "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  ci_state TEXT,\n  ci_status TEXT NOT NULL DEFAULT 'none' CHECK (ci_status IN ('none', 'ok')),\n  must TEXT NOT NULL\n);\nCREATE TABLE dismissed (id INTEGER PRIMARY KEY);\n",
        )],
    );
    assert!(load(h.path(), Mode::Check).is_ok(), "NOT NULL without default only fails when the table has rows");
    db.execute("INSERT INTO items (id, title) VALUES (1, 'x')", []).unwrap();
    let e = load(h.path(), Mode::Apply).unwrap_err().iter().map(Diagnostic::to_string).collect::<Vec<_>>().join("\n");
    assert!(
        e.contains(
            "data/prs.db: error: cannot apply schema changes: Cannot add a NOT NULL column with default value NULL"
        ),
        "{e}"
    );
    let after: i64 = db.query_row("SELECT count(*) FROM pragma_table_info('items')", [], |r| r.get(0)).unwrap();
    assert_eq!(after, 4, "failed loads change nothing");
}

#[test]
fn source_folders_allow_files_and_reject_unknown_entries() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/files/config.json", "not json"),
        ("sources/prs/files/Helper Script.sh", "#!/bin/sh\n"),
        ("sources/prs/files/nested/x.sql", "DROP TABLE prs.items"),
    ]);
    let h = home(&files);
    ok(h.path(), Mode::Check);

    write(h.path(), &[("sources/prs/view/open.sql", "SELECT id FROM prs.items"), ("sources/prs/README.md", "")]);
    let e = errors(h.path());
    assert!(e.contains("sources/prs/view: error: unknown entry: a source folder may contain only source.json, schema.sql, views/, queries/, writes/, commands/, rules/ and files/"), "{e}");
    assert!(e.contains("sources/prs/README.md: error: unknown entry"), "{e}");
    assert_eq!(e.lines().count(), 2, "{e}");
}

#[test]
fn schema_rejects_triggers_views_and_data() {
    for (sql, expected) in [
        (
            "CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END;",
            "triggers are not allowed",
        ),
        (
            "CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE VIEW v AS SELECT id FROM t;",
            "stored views are not allowed",
        ),
        (
            "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);",
            "may only contain CREATE TABLE and CREATE INDEX",
        ),
    ] {
        let h = home(&[("sources/x/schema.sql", sql)]);
        let e = errors(h.path());
        assert!(e.contains(expected), "{e}");
    }
}

#[test]
fn cross_source_table_read_is_rejected_and_view_read_allowed_through_nesting() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/board/schema.sql", "CREATE TABLE pins (\n  pr INTEGER PRIMARY KEY\n);\n"),
        (
            "sources/board/views/pinned.sql",
            "WITH p AS (SELECT pr FROM board.pins) SELECT i.id, i.title FROM p JOIN prs_items i ON i.id = p.pr",
        ),
        ("sources/feed/views/top.sql", "SELECT id, title FROM board_pinned WHERE id IN (SELECT id FROM prs_items)"),
    ]);
    let h = home(&files);
    let l = ok(h.path(), Mode::Check);
    assert_eq!(l.views["feed_top"].tables.iter().collect::<Vec<_>>(), ["board.pins", "prs.items"]);
    assert_eq!(l.views["board_pinned"].tables.iter().collect::<Vec<_>>(), ["board.pins", "prs.items"]);

    write(h.path(), &[("sources/feed/views/bad.sql", "SELECT id FROM prs.items")]);
    let e = errors(h.path());
    assert!(e.contains("sources/feed/views/bad.sql: error: reads prs.items, a private table of source prs"), "{e}");
    assert!(e.contains("use the view prs_items"), "{e}");

    write(h.path(), &[("sources/feed/views/bad.sql", "WITH x AS (SELECT id FROM prs.items) SELECT id FROM x")]);
    assert!(errors(h.path()).contains("reads prs.items, a private table"));

    write(
        h.path(),
        &[("sources/feed/views/bad.sql", "SELECT id FROM board_pinned WHERE id IN (SELECT pr FROM board.pins)")],
    );
    assert!(errors(h.path()).contains("reads board.pins, a private table of source board"));

    write(h.path(), &[("sources/feed/views/bad.sql", "SELECT id FROM items")]);
    let e = errors(h.path());
    assert!(e.contains("reads prs.items, a private table"), "{e}");
}

#[test]
fn view_name_mistakes_are_explained() {
    let mut files = PRS.to_vec();
    files.push(("sources/prs/views/open.sql", "SELECT id FROM prs_item"));
    let h = home(&files);
    let e = errors(h.path());
    assert!(e.contains("no such table: prs_item (there is no view prs_item: sources/prs/views/item.sql does not exist; views of prs: prs_items"), "{e}");

    let mut files = PRS.to_vec();
    files.push(("sources/prs/views/open.sql", "SELECT id FROM prs.missing"));
    let h = home(&files);
    assert!(errors(h.path()).contains("(source prs has tables: items)"));
}

#[test]
fn writers_may_only_write_their_own_source() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/board/schema.sql", "CREATE TABLE pins (\n  pr INTEGER PRIMARY KEY\n);\n"),
        (
            "sources/board/writes/pin.sql",
            "INSERT INTO board.pins (pr) VALUES (:pr);\nUPDATE prs.items SET title = 'pinned' WHERE id = :pr;",
        ),
    ]);
    let h = home(&files);
    let e = errors(h.path());
    assert!(e.contains("sources/board/writes/pin.sql: error: writes prs.items: a writer may only write tables of its own source (board.*)"), "{e}");

    write(
        h.path(),
        &[(
            "sources/board/writes/pin.sql",
            "INSERT INTO board.pins (pr) SELECT id FROM prs_items WHERE id = :pr;\nDELETE FROM board.pins WHERE pr = :old;",
        )],
    );
    let l = ok(h.path(), Mode::Check);
    let w = &l.writers["board.pin"];
    assert_eq!(w.statements.len(), 2);
    assert_eq!(w.tables.iter().collect::<Vec<_>>(), ["board.pins"]);

    write(h.path(), &[("sources/board/writes/pin.sql", "BEGIN; INSERT INTO board.pins (pr) VALUES (:pr); COMMIT;")]);
    assert!(errors(h.path()).contains("transactions are managed by the engine"));
}

#[test]
fn views_queries_and_select_star_rules() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/views/one.sql", "SELECT id, title FROM prs.items WHERE id = :id"),
        ("sources/prs/views/all.sql", "SELECT * FROM prs.items"),
        ("sources/prs/views/del.sql", "DELETE FROM prs.items"),
        (
            "sources/prs/queries/search.sql",
            "SELECT id, title FROM prs.items WHERE title LIKE '%' || :text || '%' AND id * 2 > 0",
        ),
    ]);
    let h = home(&files);
    let e = errors(h.path());
    assert!(e.contains("sources/prs/views/one.sql: error: views take no parameters (found :id)"), "{e}");
    assert!(e.contains("sources/prs/views/all.sql: error: SELECT * is not allowed"), "{e}");
    assert!(e.contains("sources/prs/views/del.sql: error: views must be read-only"), "{e}");
    assert!(!e.contains("search.sql"), "{e}");
}

#[test]
fn deprecated_columns_and_tables_cannot_be_read_by_views_or_queries() {
    let mut files = PRS.to_vec();
    files.push(("sources/prs/views/ci.sql", "SELECT id, ci_state FROM prs.items"));
    let h = home(&files);
    let e = errors(h.path());
    assert!(
        e.contains("reads column prs.items.ci_state, which is @deprecated in sources/prs/schema.sql: use ci_status"),
        "{e}"
    );

    let h = home(&[
        (
            "sources/old/schema.sql",
            "-- @deprecated moved to new\nCREATE TABLE things (\n  id INTEGER PRIMARY KEY\n);\nCREATE TABLE new (\n  id INTEGER PRIMARY KEY\n);\n",
        ),
        ("sources/old/queries/count.sql", "SELECT count(*) AS n FROM old.things"),
        ("sources/old/writes/copy.sql", "INSERT INTO old.new (id) SELECT id FROM old.things"),
    ]);
    let e = errors(h.path());
    assert!(e.contains("old/queries/count.sql: error: reads table old.things, which is @deprecated"), "{e}");
    assert!(!e.contains("copy.sql"), "{e}");
}

#[test]
fn syntax_errors_carry_line_and_column() {
    let mut files = PRS.to_vec();
    files.push(("sources/prs/views/broken.sql", "SELECT id,\n  title\nFROM prs.items WHERE WHERE"));
    let h = home(&files);
    let e = errors(h.path());
    assert!(e.contains("sources/prs/views/broken.sql:3:"), "{e}");
}

#[test]
fn unused_items_warn() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/views/stale.sql", "SELECT id FROM prs.items"),
        ("sources/prs/views/used.sql", "SELECT id FROM prs.items"),
        ("cards/Root.tsx", "useQuery(\"prs_used\", {}); useQuery(\"prs_items\", {}); mutate('prs.upsert', {})"),
    ]);
    let h = home(&files);
    let l = ok(h.path(), Mode::Check);
    let warnings: Vec<String> = l.warnings.iter().map(|w| w.to_string()).collect();
    assert_eq!(
        warnings,
        ["sources/prs/views/stale.sql: warning: prs_stale is not used by any view, card, command, rule or key binding"]
    );
}

#[test]
fn writer_errors_point_at_the_failing_statement() {
    let mut files = PRS.to_vec();
    files.push((
        "sources/prs/writes/two.sql",
        "UPDATE prs.items SET title = :t WHERE id = :id;\nUPDATE prs.items SET nope = 1 WHERE id = :id\n  AND WHERE;",
    ));
    let h = home(&files);
    assert!(errors(h.path()).contains("sources/prs/writes/two.sql:3:7: error: near \"WHERE\": syntax error"));
}

#[test]
fn now_dependence_propagates_through_views() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/views/fresh.sql", "SELECT id FROM prs.items WHERE unixepoch('now') - id < 60"),
        ("sources/feed/views/fresh.sql", "SELECT id FROM prs_fresh"),
        ("sources/feed/views/deep.sql", "SELECT id FROM feed_fresh"),
    ]);
    let h = home(&files);
    let l = ok(h.path(), Mode::Check);
    assert!(
        l.views["prs_fresh"].time_dependent
            && l.views["feed_fresh"].time_dependent
            && !l.views["prs_items"].time_dependent
    );
    assert!(l.views["feed_deep"].time_dependent, "now-dependence must propagate through any depth of views");
}

#[test]
fn sqlite_is_built_with_125_attached_databases() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    for i in 0..125 {
        c.execute(&format!("ATTACH ':memory:' AS d{i}"), []).unwrap();
    }
    assert!(c.execute("ATTACH ':memory:' AS d125", []).is_err());
}

#[test]
fn rule_and_keymap_validation() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/views/fresh.sql", "SELECT id, title FROM prs.items WHERE unixepoch('now') > 0"),
        ("sources/prs/writes/note.sql", "UPDATE prs.items SET title = :title WHERE id = :id"),
        ("rules/a.json", r#"{"id": "a", "when": {"view": "prs_nope"}, "run": "prs.nope"}"#),
        ("rules/b.json", r#"{"id": "b", "when": {"view": "prs_items"}, "key": "{id}@{sha}", "into": "prs.note", "args": {"id": "{id}"}}"#),
        ("rules/c.json", r#"{"id": "c", "when": {"schedule": "every minute"}, "into": "prs.upsert", "args": {"id": 1, "title": "x"}, "max_per_hour": 0}"#),
        ("rules/d.json", r#"{"id": "d", "when": {"view": "prs_fresh"}, "key": "{id}", "into": "prs.note", "args": {"id": "{id}", "title": "{title}"}, "colour": 1}"#),
        ("rules/e.json", r#"{"id": "a", "when": {"schedule": "0 * * * *"}, "into": "prs.upsert", "args": {"id": 1, "title": "{title}"}}"#),
        ("keymap.json", r#"[{"key": "f", "command": "prs.nope"}, {"key": "g", "write": "prs.upsert", "command": "palette.open"}, {"key": "x", "write": null}, {"command": "core.snapshot"}, {"key": "k", "command": "keymap.context"}]"#),
    ]);
    let h = home(&files);
    let e = errors(h.path());
    for expected in [
        "rules/a.json: error: when.view prs_nope does not exist",
        "rules/a.json: error: key is required for a rule with when.view",
        "rules/a.json: error: run: no command named prs.nope",
        "rules/b.json: error: {sha} is not a column of prs_items (columns: id, title)",
        "rules/b.json: error: args must provide exactly the params of prs.note: :id, :title",
        "rules/c.json: error: when.schedule \"every minute\":",
        "rules/c.json: error: max_per_hour must be a positive integer",
        "rules/d.json: error: unknown field colour",
        "rules/e.json: error: rule id a is already used by another rule",
        "rules/e.json: error: {title} needs when.view to take values from",
        "keymap.json[0]: error: no command named prs.nope",
        "keymap.json[1]: error: a binding needs exactly one of command or write",
        "keymap.json[3]: error: key is required",
    ] {
        assert!(e.contains(expected), "missing {expected:?} in\n{e}");
    }
    assert!(!e.contains("keymap.json[2]") && !e.contains("keymap.json[4]"), "{e}");
    let d = load(h.path(), Mode::Check).unwrap_err();
    assert!(d.iter().any(|d| d.level == Level::Warning
        && d.path == "rules/d.json"
        && d.message.contains("prs_fresh depends on the current time")));
}

#[test]
fn trigger_validation() {
    let mut files = PRS.to_vec();
    files.extend([
        ("rules/a.json", r#"{"id": "a", "when": {"schedule": "* * * * *", "system": "wake"}, "run": "core.snapshot"}"#),
        ("rules/b.json", r#"{"id": "b", "when": {"system": "reboot"}, "run": "core.snapshot"}"#),
        ("rules/c.json", r#"{"id": "c", "when": {"files": "logs/*.log"}, "run": "core.snapshot"}"#),
        ("rules/d.json", r#"{"id": "d", "when": {"view": "prs_items", "line_contains": "x"}, "key": "{id}", "run": "core.snapshot"}"#),
        ("rules/e.json", r#"{"id": "e", "when": {"files": "/tmp/*.log"}, "into": "prs.upsert", "args": {"id": 1, "title": "{line}"}}"#),
        ("rules/f.json", r#"{"id": "f", "when": {"files": "/tmp/*.log", "line_contains": "ERROR"}, "into": "prs.upsert", "args": {"id": 1, "title": "{path}: {line}"}}"#),
        ("rules/g.json", r#"{"id": "g", "when": {"system": "unlock"}, "into": "prs.upsert", "args": {"id": 1, "title": "{event}"}, "log": false}"#),
        ("rules/h.json", r#"{"id": "h", "when": {"view": "prs_items"}, "key": "{id}", "run": "core.snapshot", "log": false}"#),
        ("rules/i.json", r#"{"id": "i", "when": {"system": "wake"}, "run": "core.snapshot", "log": "no"}"#),
    ]);
    let h = home(&files);
    let e = errors(h.path());
    for expected in [
        "rules/a.json: error: a rule takes at most one trigger, got when.schedule, when.system",
        "rules/b.json: error: when.system \"reboot\" is not a system event (expected sleep, wake, lock, unlock, online, offline, idle, active)",
        "rules/c.json: error: when.files \"logs/*.log\" must be an absolute path or start with ~/",
        "rules/d.json: error: when.line_contains needs when.files",
        "rules/e.json: error: {line} is not a variable of the trigger (variables: path)",
        "rules/h.json: error: log: false needs a rule without when.view",
        "rules/i.json: error: log must be true or false",
    ] {
        assert!(e.contains(expected), "missing {expected:?} in\n{e}");
    }
    assert!(!e.contains("rules/f.json") && !e.contains("rules/g.json"), "{e}");
}

#[test]
fn cards_compile_with_lib_helpers() {
    let h = home(&[
        (
            "cards/Root.tsx",
            "import { CardSlot } from \"switchboard\"\nimport { label } from \"./lib/label\"\nimport { Bold } from \"./lib/bold\"\nexport default function Root() { return <CardSlot component=\"Other\" id={label} props={{ b: <Bold text={label} /> }} /> }\n",
        ),
        (
            "cards/lib/label.ts",
            "import { prefix } from \"./deep/prefix.js\"\nexport const label: string = prefix + \"main\"\n",
        ),
        ("cards/lib/deep/prefix.js", "export const prefix = \"p-\"\n"),
        ("cards/lib/bold.tsx", "export const Bold = ({ text }: { text: string }) => <b>{text}</b>\n"),
        ("cards/Other.tsx", "export default function Other() { return null }\n"),
    ]);
    let l = ok(h.path(), Mode::Check);
    let root = &l.cards["Root"];
    assert_eq!(root.keys().collect::<Vec<_>>(), ["Root.tsx", "lib/bold.tsx", "lib/deep/prefix.js", "lib/label.ts"]);
    assert!(root["Root.tsx"].contains("__vite_ssr_import__(\"lib/label.ts\""), "{}", root["Root.tsx"]);
    assert!(root["Root.tsx"].contains("__vite_ssr_import__(\"react/jsx-runtime\""));
    assert!(
        root["lib/label.ts"].contains("__vite_ssr_import__(\"lib/deep/prefix.js\"")
            && !root["lib/label.ts"].contains(": string")
    );
    assert_eq!(l.cards["Other"].keys().collect::<Vec<_>>(), ["Other.tsx"]);
}

#[test]
fn card_syntax_errors_have_line_and_column() {
    let h = home(&[
        ("cards/Root.tsx", "export default function Root() {\n  const n: number = 1\n  return <div>{n +}</div>\n}\n"),
        ("cards/lib/bad.ts", "export const x: = 1\n"),
    ]);
    let e = errors(h.path());
    assert!(e.contains("cards/Root.tsx:3:19: error: Unexpected token"), "{e}");
    assert!(e.contains("cards/lib/bad.ts:1:17: error: Unexpected token"), "{e}");
}

#[test]
fn card_imports_are_restricted() {
    let h = home(&[
        (
            "cards/Root.tsx",
            "import \"react\"\nimport \"react/jsx-runtime\"\nimport \"switchboard\"\nimport \"./lib/ok\"\nimport \"./Other\"\nimport { z } from \"zod\"\nexport * from \"../outside\"\nimport \"./lib/missing\"\nimport \"/Users/x/cards/lib/ok\"\nconst later = import(\"./lib/ok\")\nexport default () => import.meta.url\n",
        ),
        ("cards/Other.tsx", "export default () => null\n"),
        ("cards/lib/ok.ts", "import \"../Root\"\nexport { x } from \"../../sources/x\"\n"),
    ]);
    let e = errors(h.path());
    for expected in [
        "cards/Root.tsx:5:8: error: imports the card Other: cards cannot import each other; compose with <CardSlot component=\"Other\" />",
        "cards/Root.tsx:6:19: error: imports \"zod\": npm packages are not supported yet",
        "cards/Root.tsx:7:15: error: imports \"../outside\", which is outside cards/lib/",
        "cards/Root.tsx:8:8: error: imports \"./lib/missing\": no file cards/lib/missing with extension .ts, .tsx or .js",
        "cards/Root.tsx:9:8: error: imports \"/Users/x/cards/lib/ok\", which is outside cards/lib/",
        "cards/Root.tsx:10:15: error: dynamic import() is not supported",
        "cards/Root.tsx:11:22: error: import.meta is not available in cards",
        "cards/lib/ok.ts:1:8: error: imports the card Root",
        "cards/lib/ok.ts:2:19: error: imports \"../../sources/x\", which is outside cards/lib/",
    ] {
        assert!(e.contains(expected), "missing {expected} in\n{e}");
    }
    assert_eq!(e.lines().count(), 9, "{e}");
}

#[test]
fn introspection_functions_and_other_sources_schema_are_denied() {
    for (sql, expected) in [
        ("SELECT name AS id FROM pragma_table_info('items', 'prs')", "pragma_table_info is not allowed"),
        ("SELECT name AS id FROM pragma_function_list", "pragma_function_list is not allowed"),
        ("SELECT name AS id FROM dbstat('prs')", "dbstat is not allowed"),
        ("SELECT name AS id FROM prs.sqlite_schema", "reads prs.sqlite_master, a private table of source prs"),
        ("SELECT load_extension('x') AS id", "load_extension is not allowed"),
    ] {
        let mut files = PRS.to_vec();
        files.push(("sources/feed/views/leak.sql", sql));
        let h = home(&files);
        let e = errors(h.path());
        assert!(e.contains(expected), "{sql}: {e}");
    }
    let mut files = PRS.to_vec();
    files.push((
        "sources/prs/views/own.sql",
        "SELECT value AS id FROM json_each('[1]') UNION ALL SELECT name FROM prs.sqlite_schema",
    ));
    ok(home(&files).path(), Mode::Check);
}

#[test]
fn every_implicit_now_form_is_time_dependent() {
    let now = [
        "unixepoch()",
        "date()",
        "time( )",
        "datetime()",
        "julianday()",
        "strftime('%s')",
        "datetime('now', '-1 day')",
        "CURRENT_TIMESTAMP",
        "timediff('now', '2026-01-01')",
    ];
    let not_now = ["datetime(created, 'unixepoch')", "strftime('%Y', created)", "date(created)", "unixepoch(created)"];
    let mut files = PRS.to_vec();
    let sql: Vec<String> = now.iter().chain(&not_now).map(|f| format!("SELECT id, {f} AS t FROM prs.items")).collect();
    let paths: Vec<String> = (0..sql.len()).map(|i| format!("sources/prs/views/t{i}.sql")).collect();
    files.push((
        "sources/prs/schema.sql",
        "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  title TEXT,\n  created TEXT\n);\n",
    ));
    files.extend(paths.iter().map(String::as_str).zip(sql.iter().map(String::as_str)));
    let h = home(&files);
    let l = ok(h.path(), Mode::Check);
    for (i, f) in now.iter().enumerate() {
        assert!(l.views[&format!("prs_t{i}")].time_dependent, "{f} should be time-dependent");
    }
    for (i, f) in not_now.iter().enumerate() {
        assert!(!l.views[&format!("prs_t{}", now.len() + i)].time_dependent, "{f} should not be time-dependent");
    }
}

#[test]
fn only_unused_views_and_queries_warn() {
    let mut files = PRS.to_vec();
    files.extend([
        ("sources/prs/queries/lonely.sql", "SELECT id FROM prs.items WHERE id = :id"),
        ("sources/prs/commands/idle", "#!/bin/sh\n"),
        ("cards/Root.tsx", "useQuery(\"prs_items\", {}); export default () => null"),
        ("cards/Orphan.tsx", "export default () => null"),
    ]);
    let h = home(&files);
    std::process::Command::new("chmod").arg("+x").arg(h.path().join("sources/prs/commands/idle")).status().unwrap();
    let l = ok(h.path(), Mode::Check);
    let warnings: Vec<String> = l.warnings.iter().map(|w| w.to_string()).collect();
    assert_eq!(
        warnings,
        [
            "sources/prs/queries/lonely.sql: warning: prs.lonely is not used by any view, card, command, rule or key binding"
        ]
    );
}

#[test]
fn core_views_never_filter() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("core-source/views");
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let sql = fs::read_to_string(&path).unwrap().to_lowercase();
        assert!(!sql.contains("where") && !sql.contains("limit"), "{name}");
    }
}

#[test]
fn badge_names_an_existing_view() {
    let h = home(PRS);
    write(h.path(), &[("settings.json", r#"{"badge": "prs_nope"}"#)]);
    assert_eq!(errors(h.path()), "settings.json: error: badge: no view named prs_nope");
    write(h.path(), &[("settings.json", r#"{"badge": 1}"#)]);
    assert_eq!(errors(h.path()), "settings.json: error: badge must be a string");
    for badge in ["prs_items", ""] {
        write(h.path(), &[("settings.json", &format!(r#"{{"badge": "{badge}"}}"#))]);
        assert_eq!(ok(h.path(), Mode::Check).settings.badge, badge);
    }
    assert_eq!(ok(home(PRS).path(), Mode::Check).settings.badge, "");
}

#[test]
fn push_and_idle_after() {
    let h = home(PRS);
    let settings = ok(h.path(), Mode::Check).settings;
    assert_eq!((settings.push.as_str(), settings.idle_after.as_secs()), ("idle", 120));
    write(h.path(), &[("settings.json", r#"{"push": "sometimes"}"#)]);
    assert_eq!(errors(h.path()), "settings.json: error: push must be one of off, locked, idle, always");
    write(h.path(), &[("rules/idle.json", r#"{"id": "idle", "when": {"system": "idle"}, "run": "core.snapshot"}"#)]);
    write(h.path(), &[("settings.json", r#"{"push": "locked", "idle_after": 30}"#)]);
    assert_eq!(ok(h.path(), Mode::Check).settings.push, "locked");
}

#[test]
fn remote_and_queue_expiry() {
    let h = home(PRS);
    assert_eq!(ok(h.path(), Mode::Check).settings.remote, None);
    write(h.path(), &[("settings.json", r#"{"remote": 8443, "queue_run_expiry": 60}"#)]);
    let settings = ok(h.path(), Mode::Check).settings;
    assert_eq!((settings.remote, settings.queue_run_expiry.as_secs()), (Some(8443), 60));
    write(h.path(), &[("settings.json", r#"{"remote": 70000}"#)]);
    assert_eq!(errors(h.path()), "settings.json: error: remote must be a port number (1 to 65535)");
    write(h.path(), &[("settings.json", "{}")]);
    write(h.path(), &[("sources/prs/commands/open", "#!/bin/sh\n")]);
    std::process::Command::new("chmod").arg("+x").arg(h.path().join("sources/prs/commands/open")).status().unwrap();
    write(h.path(), &[("sources/prs/source.json", r#"{"queue_expiry": {"open": 0}}"#)]);
    let loaded = ok(h.path(), Mode::Check);
    assert_eq!(loaded.sources["prs"].config.queue_expiry["open"].as_secs(), 0);
    write(h.path(), &[("sources/prs/source.json", r#"{"queue_expiry": {"nope": 5}}"#)]);
    assert_eq!(
        errors(h.path()),
        "sources/prs/source.json: error: queue_expiry must be an object mapping this source's command names to seconds (0 for never)"
    );
}
