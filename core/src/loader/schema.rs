//! `schema.sql`: run in a scratch database, then diffed against the real database into an additive migration.

use super::authorizer::{Authorizer, Policy, SqlError};
use super::sql_text::{DeprecatedItem, column_definition, deprecations};
use super::{CORE_SOURCE, Diagnostics, SourceFiles};
use rusqlite::{Connection, OpenFlags};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A source's schema in an in-memory database, attachable by URI while `_conn` keeps it alive.
pub(super) struct Scratch {
    pub source: String,
    pub uri: String,
    _conn: Connection,
}

pub(super) struct Migration {
    pub db: PathBuf,
    pub ddl: Vec<String>,
}

#[derive(Default)]
pub(super) struct Schemas {
    pub scratches: Vec<Scratch>,
    /// Tables of each source whose schema loaded.
    pub tables: BTreeMap<String, BTreeSet<String>>,
    /// Sources whose schema.sql failed to execute.
    pub broken: BTreeSet<String>,
    /// Keyed by source; the value is the deprecation note.
    pub deprecated: BTreeMap<(String, DeprecatedItem), String>,
    pub migrations: Vec<Migration>,
    pub databases: BTreeMap<String, PathBuf>,
}

impl Schemas {
    pub fn deprecation(&self, source: &str, table: &str, column: Option<&str>) -> Option<&String> {
        let item = DeprecatedItem { table: table.into(), column: column.map(String::from) };
        self.deprecated.get(&(source.to_string(), item))
    }
}

pub(super) fn check(sources: &[SourceFiles], data: &Path, diags: &mut Diagnostics) -> Schemas {
    static NEXT_SCRATCH: AtomicU64 = AtomicU64::new(0);
    let scratch_prefix = format!("{}-{}", std::process::id(), NEXT_SCRATCH.fetch_add(1, Ordering::Relaxed));
    let mut schemas = Schemas::default();
    for SourceFiles { name, dir, files } in sources {
        let db = data.join(format!("{name}.db"));
        let path = format!("{dir}/schema.sql");
        let Some(schema) = files.get("schema.sql") else {
            if db.exists() {
                diags.error(
                    path,
                    format!("missing, but data/{name}.db exists: tables cannot be dropped (schema.sql is additive-only); restore schema.sql"),
                );
            }
            continue;
        };
        let uri = format!("file:/switchboard-{scratch_prefix}-{name}?vfs=memdb");
        let scratch = Connection::open(&uri).and_then(|mut conn| {
            let authorizer = Authorizer::install(&mut conn, Policy::Schema)?;
            Ok((conn, authorizer))
        });
        let Ok((mut scratch, authorizer)) = scratch else {
            diags.error(&path, "cannot open a scratch database");
            continue;
        };
        if let Err(error) = scratch.execute_batch(schema) {
            let (location, message) = SqlError { error, denied: authorizer.take_denied() }.describe(&path, schema, 0);
            diags.error(location, message);
            schemas.broken.insert(name.clone());
            continue;
        }
        if let Err(e) = Authorizer::uninstall(&mut scratch) {
            diags.error(&path, format!("cannot inspect the scratch database: {e}"));
            continue;
        }
        let tables: BTreeSet<String> =
            schema_objects(&scratch, ObjectKind::Table).map(|t| t.into_keys().collect()).unwrap_or_default();

        let (found, misplaced) = deprecations(schema);
        for (line, message) in misplaced {
            diags.error(format!("{path}:{line}"), message);
        }
        for deprecation in found {
            let exists = match &deprecation.item.column {
                None => tables.contains(&deprecation.item.table),
                Some(column) => table_columns(&scratch, &deprecation.item.table)
                    .is_ok_and(|columns| columns.iter().any(|c| c.name == *column)),
            };
            if !exists {
                let item = &deprecation.item;
                let key = item.column.as_ref().map_or(item.table.clone(), |c| format!("{}.{c}", item.table));
                diags.error(
                    format!("{path}:{}", deprecation.line),
                    format!("@deprecated: {key} is not a table or column defined here; put it on the column's own line or directly above CREATE TABLE"),
                );
            }
            schemas.deprecated.insert((name.clone(), deprecation.item), deprecation.note);
        }
        schemas.tables.insert(name.clone(), tables);

        let existing = if db.exists() {
            Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        } else {
            Connection::open_in_memory()
        };
        let may_drop_tables = name == CORE_SOURCE;
        match existing.and_then(|existing| plan_migration(&scratch, &existing, may_drop_tables)) {
            Ok(MigrationPlan { ddl, refused }) => {
                for message in refused {
                    diags.error(&path, message);
                }
                if !ddl.is_empty() || !db.exists() {
                    schemas.migrations.push(Migration { db: db.clone(), ddl });
                }
            }
            Err(e) => diags.error(&path, format!("cannot read data/{name}.db: {e}")),
        }
        schemas.databases.insert(name.clone(), db);
        schemas.scratches.push(Scratch { source: name.clone(), uri, _conn: scratch });
    }
    schemas
}

#[derive(Clone, Copy)]
enum ObjectKind {
    Table,
    Index,
}

/// Lowercased name → `CREATE` statement.
fn schema_objects(conn: &Connection, kind: ObjectKind) -> rusqlite::Result<BTreeMap<String, String>> {
    let kind = match kind {
        ObjectKind::Table => "table",
        ObjectKind::Index => "index",
    };
    conn.prepare_cached(
        "SELECT lower(name), sql FROM sqlite_schema WHERE type = ?1 AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    )?
    .query_map([kind], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
}

#[derive(PartialEq)]
struct ColumnInfo {
    name: String,
    declared_type: String,
    not_null: bool,
    default: Option<String>,
    primary_key_position: i64,
}

impl ColumnInfo {
    fn describe(&self) -> String {
        let mut out = self.declared_type.clone();
        if self.not_null {
            out += " NOT NULL";
        }
        if let Some(default) = &self.default {
            out += &format!(" DEFAULT {default}");
        }
        if self.primary_key_position > 0 {
            out += " PRIMARY KEY";
        }
        out.trim().to_string()
    }
}

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<ColumnInfo>> {
    conn.prepare_cached("SELECT lower(name), upper(type), \"notnull\", dflt_value, pk FROM pragma_table_info(?1)")?
        .query_map([table], |r| {
            Ok(ColumnInfo {
                name: r.get(0)?,
                declared_type: r.get(1)?,
                not_null: r.get(2)?,
                default: r.get(3)?,
                primary_key_position: r.get(4)?,
            })
        })?
        .collect()
}

struct MigrationPlan {
    ddl: Vec<String>,
    refused: Vec<String>,
}

/// The DDL that brings `existing` to `wanted`, refusing any change that is not additive. Index changes are free.
fn plan_migration(
    wanted: &Connection,
    existing: &Connection,
    may_drop_tables: bool,
) -> rusqlite::Result<MigrationPlan> {
    let (wanted_tables, existing_tables) =
        (schema_objects(wanted, ObjectKind::Table)?, schema_objects(existing, ObjectKind::Table)?);
    let (wanted_indexes, existing_indexes) =
        (schema_objects(wanted, ObjectKind::Index)?, schema_objects(existing, ObjectKind::Index)?);
    let mut ddl = Vec::new();
    let mut refused = Vec::new();
    for table in existing_tables.keys().filter(|t| !wanted_tables.contains_key(*t)) {
        if may_drop_tables {
            ddl.push(format!("DROP TABLE \"{table}\""));
        } else {
            refused.push(format!(
                "table {table} exists in the database but not in schema.sql: tables cannot be dropped or renamed (schema.sql is additive-only). Restore its CREATE TABLE and mark it -- @deprecated if it is unused"
            ));
        }
    }
    for (table, create) in &wanted_tables {
        if !existing_tables.contains_key(table) {
            ddl.push(create.clone());
            continue;
        }
        let (wanted_columns, existing_columns) = (table_columns(wanted, table)?, table_columns(existing, table)?);
        for old in &existing_columns {
            match wanted_columns.iter().find(|new| new.name == old.name) {
                None => refused.push(format!(
                    "column {table}.{} was removed or renamed: columns cannot be dropped or renamed (schema.sql is additive-only). Restore it, mark it -- @deprecated, and add a new column",
                    old.name
                )),
                Some(new) if new != old => refused.push(format!(
                    "column {table}.{} changed from `{}` to `{}`: column definitions cannot change. Add a new column instead",
                    old.name,
                    old.describe(),
                    new.describe()
                )),
                Some(_) => {}
            }
        }
        for new in wanted_columns.iter().filter(|new| !existing_columns.iter().any(|old| old.name == new.name)) {
            match column_definition(create, &new.name) {
                Some(definition) => ddl.push(format!("ALTER TABLE \"{table}\" ADD COLUMN {definition}")),
                None => refused.push(format!("new column {table}.{} must be defined on its own line", new.name)),
            }
        }
    }
    for (index, create) in &existing_indexes {
        if wanted_indexes.get(index) != Some(create) {
            ddl.push(format!("DROP INDEX IF EXISTS \"{index}\""));
        }
    }
    for (index, create) in &wanted_indexes {
        if existing_indexes.get(index) != Some(create) {
            ddl.push(create.clone());
        }
    }
    if refused.is_empty() && !ddl.is_empty() {
        let replica = Connection::open_in_memory()?;
        for create in existing_tables.values().chain(existing_indexes.values()) {
            replica.execute_batch(create)?;
        }
        for statement in &ddl {
            if let Err(e) = replica.execute_batch(statement) {
                refused.push(format!("cannot apply `{statement}`: {e}"));
            }
        }
    }
    Ok(MigrationPlan { ddl, refused })
}

/// Applies the migrations in one transaction per database, creating new databases in WAL mode.
pub(super) fn apply(migrations: &[Migration], home: &Path, data: &Path, diags: &mut Diagnostics) {
    let _ = std::fs::create_dir_all(data);
    for Migration { db, ddl } in migrations {
        let applied = Connection::open(db).and_then(|conn| {
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
            conn.execute_batch(&format!("BEGIN;\n{};\nCOMMIT;", ddl.join(";\n")))
        });
        if let Err(e) = applied {
            diags.error(
                db.strip_prefix(home).unwrap_or(db).to_string_lossy(),
                format!("cannot apply schema changes: {e}"),
            );
        }
    }
}
