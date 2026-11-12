//! Views, queries and writers, prepared against the scratch schemas to learn their columns, parameters and the
//! tables they read and write, and to enforce that a source's tables are only touched from inside it.

use super::authorizer::{Authorizer, Policy, Prepared, ResultColumn};
use super::schema::Schemas;
use super::sql_text::{code_only, mentions_word, reads_current_time, selects_star, split_statements};
use super::{Diagnostics, Select, SourceFiles, Statement, Writer};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    View,
    Query,
    Writer,
}

struct SqlFile<'a> {
    kind: Kind,
    source: &'a str,
    path: String,
    name: String,
    sql: &'a str,
    valid: bool,
    columns: Vec<ResultColumn>,
    /// `source.table` of every table read, through any depth of views.
    base_tables: BTreeSet<String>,
    views_read: BTreeSet<String>,
    statements: Vec<Statement>,
    /// `source.table` of every table written.
    writes: BTreeSet<String>,
}

#[derive(Default)]
pub(super) struct Checked {
    pub views: BTreeMap<String, Select>,
    pub queries: BTreeMap<String, Select>,
    pub writers: BTreeMap<String, Writer>,
    /// Views read by another view, query or writer.
    pub nested_views: BTreeSet<String>,
}

pub(super) fn check(sources: &[SourceFiles], schemas: &Schemas, diags: &mut Diagnostics) -> Checked {
    let mut files = collect(sources, diags);
    let checker = Connection::open_in_memory().and_then(|mut conn| {
        let authorizer = Authorizer::install(&mut conn, Policy::Statements)?;
        Ok((conn, authorizer))
    });
    let (conn, authorizer) = match checker {
        Ok(checker) => checker,
        Err(e) => {
            diags.error("sources", format!("cannot open the checking database: {e}"));
            return Checked::default();
        }
    };
    authorizer.unrestricted(|| {
        for scratch in &schemas.scratches {
            if let Err(e) = conn.execute(&format!("ATTACH ?1 AS \"{}\"", scratch.source), [&scratch.uri]) {
                diags.error(format!("sources/{}", scratch.source), format!("cannot attach: {e}"));
            }
        }
        for view in files.iter().filter(|f| f.kind == Kind::View) {
            // A view that cannot be created is reported when its SELECT is prepared below.
            let _ = conn.execute(&format!("CREATE TEMP VIEW \"{}\" AS {}", view.name, view.sql), []);
        }
    });

    let mut context = Context {
        schemas,
        sources: sources.iter().map(|s| s.name.as_str()).collect(),
        views: files.iter().filter(|f| f.kind == Kind::View).map(|f| (f.name.clone(), f.source)).collect(),
        failed_views: BTreeSet::new(),
    };
    resolve_selects(&mut files, &conn, &authorizer, &mut context, diags);

    // Each view becomes an empty table with its columns, so a statement's reported reads are its own.
    authorizer.unrestricted(|| {
        for view in files.iter().filter(|f| f.kind == Kind::View) {
            let _ = conn.execute(&format!("DROP VIEW IF EXISTS temp.\"{}\"", view.name), []);
            if view.valid {
                let columns: Vec<_> =
                    view.columns.iter().map(|c| format!("\"{}\"", c.name.replace('"', "\"\""))).collect();
                let _ = conn.execute(&format!("CREATE TEMP TABLE \"{}\" ({})", view.name, columns.join(", ")), []);
            }
        }
    });
    for file in files.iter_mut().filter(|f| f.valid) {
        check_statements(file, &conn, &authorizer, &context, diags);
    }

    let time_dependent: BTreeSet<String> =
        files.iter().filter(|f| f.kind == Kind::View && reads_current_time(f.sql)).map(|f| f.name.clone()).collect();
    let mut checked = Checked {
        nested_views: files.iter().flat_map(|f| f.views_read.iter().cloned()).collect(),
        ..Checked::default()
    };
    for file in files {
        if file.kind == Kind::Writer {
            let mut params: Vec<String> = Vec::new();
            for param in file.statements.iter().flat_map(|s| &s.params) {
                if !params.contains(param) {
                    params.push(param.clone());
                }
            }
            let writer = Writer {
                source: file.source.to_string(),
                path: file.path,
                statements: file.statements,
                params,
                tables: file.writes,
            };
            checked.writers.insert(file.name, writer);
            continue;
        }
        let select = Select {
            source: file.source.to_string(),
            path: file.path,
            sql: file.sql.to_string(),
            columns: file.columns.iter().map(|c| c.name.clone()).collect(),
            untyped_columns: file.columns.iter().filter(|c| c.untyped).map(|c| c.name.clone()).collect(),
            params: file.statements.into_iter().next().map(|s| s.params).unwrap_or_default(),
            tables: file.base_tables,
            time_dependent: time_dependent.contains(&file.name) || !file.views_read.is_disjoint(&time_dependent),
        };
        let selects = if file.kind == Kind::View { &mut checked.views } else { &mut checked.queries };
        selects.insert(file.name, select);
    }
    checked
}

fn collect<'a>(sources: &'a [SourceFiles], diags: &mut Diagnostics) -> Vec<SqlFile<'a>> {
    let mut out = Vec::new();
    for SourceFiles { name: source, dir, files } in sources {
        for (rel, sql) in files {
            let (kind, file) = match rel.split_once('/') {
                Some(("views", f)) => (Kind::View, f),
                Some(("queries", f)) => (Kind::Query, f),
                Some(("writes", f)) => (Kind::Writer, f),
                _ => continue,
            };
            let path = format!("{dir}/{rel}");
            let stem = file.strip_suffix(".sql").filter(|s| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
            let Some(stem) = stem else {
                diags.error(path, "SQL file names must be lowercase snake_case and end in .sql");
                continue;
            };
            out.push(SqlFile {
                kind,
                source,
                path,
                name: if kind == Kind::View { format!("{source}_{stem}") } else { format!("{source}.{stem}") },
                sql,
                valid: true,
                columns: Vec::new(),
                base_tables: BTreeSet::new(),
                views_read: BTreeSet::new(),
                statements: Vec::new(),
                writes: BTreeSet::new(),
            });
        }
    }
    out
}

/// First pass, with views as real views: the result columns of views and queries, and the base tables they read
/// through any depth of views.
fn resolve_selects(
    files: &mut [SqlFile],
    conn: &Connection,
    authorizer: &Authorizer,
    context: &mut Context,
    diags: &mut Diagnostics,
) {
    let mut unprepared = Vec::new();
    for file in files.iter_mut().filter(|f| f.kind != Kind::Writer) {
        match authorizer.prepare(conn, file.sql) {
            Ok(prepared) => {
                file.columns = prepared.columns;
                let names: Vec<&str> = file.columns.iter().map(|c| c.name.as_str()).collect();
                if let Some(duplicate) = names.iter().enumerate().find(|(i, c)| names[..*i].contains(c)).map(|(_, c)| c)
                {
                    diags.error(
                        &file.path,
                        format!("duplicate column name {duplicate}: give each column a distinct alias"),
                    );
                    file.valid = false;
                }
                for read in prepared.reads {
                    match read.db.as_str() {
                        "temp" => _ = file.views_read.insert(read.table),
                        "main" => {}
                        db => _ = file.base_tables.insert(format!("{db}.{}", read.table)),
                    }
                }
            }
            Err(e) => {
                unprepared.push((file.name.clone(), file.sql, e.describe(&file.path, file.sql, 0)));
                file.valid = false;
            }
        }
        if !file.valid && file.kind == Kind::View {
            context.failed_views.insert(file.name.clone());
        }
    }
    // Reported once every view has been tried, so an error can point at the failed view it depends on.
    for (name, sql, (location, message)) in unprepared {
        let message = context.explain(&message);
        let culprits: Vec<&str> =
            context.failed_views.iter().filter(|v| **v != name && mentions_word(sql, v)).map(String::as_str).collect();
        if culprits.is_empty() {
            diags.error(location, message);
        } else {
            diags.error(
                location,
                format!("{message} (it reads {}, which failed to load; fix that first)", culprits.join(", ")),
            );
        }
    }
}

/// Second pass, with views as tables: each statement's parameters and its own reads and writes.
fn check_statements(
    file: &mut SqlFile,
    conn: &Connection,
    authorizer: &Authorizer,
    context: &Context,
    diags: &mut Diagnostics,
) {
    let statements = if file.kind == Kind::Writer { split_statements(file.sql) } else { vec![(0, file.sql)] };
    let mut readonly = true;
    for (offset, sql) in statements {
        let prepared = match authorizer.prepare(conn, sql) {
            Ok(prepared) => prepared,
            Err(e) => {
                let (location, message) = e.describe(&file.path, file.sql, offset);
                diags.error(location, context.explain(&message));
                file.valid = false;
                continue;
            }
        };
        readonly &= prepared.readonly;
        for read in prepared.reads.iter().filter(|r| r.db == "temp") {
            file.views_read.insert(read.table.clone());
        }
        for write in prepared.writes.iter().filter(|w| w.db == file.source) {
            file.writes.insert(format!("{}.{}", write.db, write.table));
        }
        let problems = statement_problems(file.kind, file.source, &prepared, sql, context);
        for problem in &problems {
            diags.error(&file.path, problem.clone());
        }
        file.valid &= problems.is_empty();
        let params = prepared.params.into_iter().flatten().map(|p| p[1..].to_string()).collect();
        file.statements.push(Statement { sql: sql.to_string(), params });
    }
    if file.kind == Kind::Writer && file.valid && readonly {
        diags.error(&file.path, "a writer must INSERT, UPDATE or DELETE");
    }
}

fn statement_problems(kind: Kind, source: &str, prepared: &Prepared, sql: &str, context: &Context) -> BTreeSet<String> {
    let mut problems = BTreeSet::new();
    match kind {
        Kind::View if !prepared.readonly => _ = problems.insert("views must be read-only SELECTs".to_string()),
        Kind::Query if !prepared.readonly => _ = problems.insert("queries must be read-only SELECTs".to_string()),
        Kind::View if !prepared.params.is_empty() => _ = problems.insert(format!(
            "views take no parameters (found {}); put parameterised SELECTs in queries/, or let callers filter the view by column equality",
            prepared.params.iter().map(|p| p.as_deref().unwrap_or("?")).collect::<Vec<_>>().join(", ")
        )),
        _ => {}
    }
    if prepared.params.iter().any(|p| !p.as_ref().is_some_and(|p| p.starts_with(':'))) {
        problems.insert("parameters must be named, like :id".into());
    }
    for read in &prepared.reads {
        let (db, table) = (read.db.as_str(), read.table.as_str());
        if db == "temp" {
            continue;
        }
        if db == source {
            if kind == Kind::Writer {
                continue;
            }
            let deprecated =
                context.schemas.deprecation(db, table, None).map(|note| (format!("table {db}.{table}"), note)).or_else(
                    || {
                        let column = read.column.as_str();
                        let note = context.schemas.deprecation(db, table, Some(column))?;
                        Some((format!("column {db}.{table}.{column}"), note))
                    },
                );
            if let Some((what, note)) = deprecated {
                problems.insert(format!("reads {what}, which is @deprecated in sources/{db}/schema.sql: {note}"));
            }
        } else if db == "main" {
            if !["json_each", "json_tree", "jsonb_each", "jsonb_tree"].contains(&table) {
                problems.insert(format!("{table} is not allowed: SQL may use json_each and json_tree, but not pragma or other introspection table functions"));
            }
        } else {
            let views = context.views_of(db);
            let suggestion = if views.contains(&format!("{db}_{table}").as_str()) {
                format!("use the view {db}_{table}")
            } else if views.is_empty() {
                format!("{db} has no views yet; add one in sources/{db}/views/")
            } else {
                format!("use one of its views: {}", views.join(", "))
            };
            let mut message = format!(
                "reads {db}.{table}, a private table of source {db}. Outside sources/{db}/, SQL may only read views ({db}.{table} names the table, {db}_{table} would name a view): {suggestion}"
            );
            if context.schemas.tables.get(source).is_some_and(|tables| tables.contains(table)) {
                message += &format!(
                    ". Unqualified table names resolve to the first attached source that has them: write {source}.{table}"
                );
            }
            problems.insert(message);
        }
    }
    for write in &prepared.writes {
        let (db, table) = (write.db.as_str(), write.table.as_str());
        if db == "temp" {
            problems.insert(format!("writes {table}, which is a view; writers write their own source's tables"));
        } else if db != source {
            problems
                .insert(format!("writes {db}.{table}: a writer may only write tables of its own source ({source}.*)"));
        }
    }
    if selects_star(&code_only(sql)) {
        problems.insert(
            "SELECT * is not allowed: list the columns, so the result doesn't change when a table gains a column"
                .into(),
        );
    }
    problems
}

struct Context<'a> {
    schemas: &'a Schemas,
    sources: BTreeSet<&'a str>,
    /// Every view file's name → its source, whether or not it loaded.
    views: BTreeMap<String, &'a str>,
    failed_views: BTreeSet<String>,
}

impl Context<'_> {
    fn views_of(&self, source: &str) -> Vec<&str> {
        self.views.iter().filter(|(_, s)| **s == source).map(|(v, _)| v.as_str()).collect()
    }

    /// Adds what the folder most likely meant to SQLite's "no such table" errors.
    fn explain(&self, message: &str) -> String {
        let Some(name) = message.strip_prefix("no such table: ") else {
            return message.into();
        };
        if self.failed_views.contains(name) {
            return format!("{message} (that view failed to load; see its own error)");
        }
        let tables = &self.schemas.tables;
        if let Some((source, table)) = name.split_once('.') {
            return match tables.get(source) {
                Some(names) => {
                    format!(
                        "{message} (source {source} has tables: {})",
                        names.iter().cloned().collect::<Vec<_>>().join(", ")
                    )
                }
                None if self.schemas.broken.contains(source) => {
                    format!("{message} (the schema.sql of {source} failed to load; see its error)")
                }
                None if self.views.contains_key(&format!("{source}_{table}")) => {
                    format!("{message} ({source} has no tables; did you mean the view {source}_{table}?)")
                }
                None => format!("{message} ({source} is not a source with a schema.sql)"),
            };
        }
        if let Some((source, file)) = name.split_once('_').filter(|(s, _)| self.sources.contains(s)) {
            let mut out = format!(
                "{message} (there is no view {name}: sources/{source}/views/{file}.sql does not exist; views of {source}: {}",
                self.views_of(source).join(", ")
            );
            if tables.get(source).is_some_and(|t| t.contains(file)) {
                out += &format!(
                    ". {source}.{file} is a private table: write {source}.{file} inside sources/{source}/, and read a view of {source} anywhere else"
                );
            }
            return out + ")";
        }
        match tables.iter().find(|(_, names)| names.contains(name)) {
            Some((source, _)) => format!("{message} (tables must be qualified with their source: {source}.{name})"),
            None => message.into(),
        }
    }
}
