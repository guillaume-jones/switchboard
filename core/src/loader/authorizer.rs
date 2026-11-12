//! SQLite's authorizer, used both to refuse statements the folder may not contain and to record which tables a
//! statement reads and writes.

use super::sql_text::location;
use rusqlite::Connection;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Policy {
    /// `schema.sql`: only `CREATE TABLE` and `CREATE INDEX`.
    Schema,
    /// Views, queries and writers: only `SELECT`, `INSERT`, `UPDATE` and `DELETE`.
    Statements,
}

pub(super) struct ColumnRead {
    pub db: String,
    pub table: String,
    pub column: String,
}

pub(super) struct TableWrite {
    pub db: String,
    pub table: String,
}

pub(super) struct ResultColumn {
    pub name: String,
    /// No declared type: an expression, whose values keep the storage class they were computed with.
    pub untyped: bool,
}

pub(super) struct Prepared {
    pub readonly: bool,
    /// Parameter names including their prefix (`:id`); `None` for positional `?` parameters.
    pub params: Vec<Option<String>>,
    pub columns: Vec<ResultColumn>,
    pub reads: Vec<ColumnRead>,
    pub writes: Vec<TableWrite>,
}

pub(super) struct SqlError {
    pub error: rusqlite::Error,
    /// Set when the authorizer refused the statement, which explains the error better than SQLite does.
    pub denied: Option<String>,
}

impl SqlError {
    /// The diagnostic location and message, for a statement starting at `statement_offset` in the file `text`.
    pub fn describe(&self, path: &str, text: &str, statement_offset: usize) -> (String, String) {
        if let Some(reason) = &self.denied {
            return (path.into(), reason.clone());
        }
        match &self.error {
            rusqlite::Error::MultipleStatement => (path.into(), "must contain exactly one statement".into()),
            rusqlite::Error::SqlInputError { msg, offset, .. } => {
                let offset = statement_offset + usize::try_from(*offset).unwrap_or(0);
                (location(path, text, offset), msg.clone())
            }
            rusqlite::Error::SqliteFailure(_, Some(msg)) => (path.into(), msg.clone()),
            e => (path.into(), e.to_string()),
        }
    }
}

#[derive(Default)]
struct Log {
    unrestricted: bool,
    denied: Option<String>,
    reads: Vec<ColumnRead>,
    writes: Vec<TableWrite>,
}

pub(super) struct Authorizer(Arc<Mutex<Log>>);

impl Authorizer {
    pub fn install(conn: &mut Connection, policy: Policy) -> rusqlite::Result<Self> {
        let log = Arc::new(Mutex::new(Log::default()));
        let shared = log.clone();
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            let mut log = shared.lock().unwrap();
            if log.unrestricted {
                return Authorization::Allow;
            }
            match log.record(ctx, policy) {
                Ok(()) => Authorization::Allow,
                Err(reason) => {
                    log.denied.get_or_insert(reason);
                    Authorization::Deny
                }
            }
        }))?;
        Ok(Self(log))
    }

    fn log(&self) -> MutexGuard<'_, Log> {
        self.0.lock().unwrap()
    }

    /// Lifts every restriction once a schema has been executed, for the checker's own introspection.
    pub fn uninstall(conn: &mut Connection) -> rusqlite::Result<()> {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
    }

    /// Runs the checker's own setup statements: everything is allowed and nothing recorded.
    pub fn unrestricted<T>(&self, f: impl FnOnce() -> T) -> T {
        self.log().unrestricted = true;
        let out = f();
        self.log().unrestricted = false;
        out
    }

    /// The reason the last statement was refused, if it was.
    pub fn take_denied(&self) -> Option<String> {
        self.log().denied.take()
    }

    pub fn prepare(&self, conn: &Connection, sql: &str) -> Result<Prepared, SqlError> {
        *self.log() = Log::default();
        let prepared = conn.prepare(sql).map(|statement| {
            let params = (1..=statement.parameter_count()).map(|i| statement.parameter_name(i).map(String::from));
            let columns = statement
                .columns()
                .map(|c| ResultColumn { name: c.name().to_string(), untyped: c.decl_type().is_none() });
            (statement.readonly(), params.collect(), columns.collect())
        });
        let mut log = self.log();
        match prepared {
            Ok((readonly, params, columns)) => Ok(Prepared {
                readonly,
                params,
                columns,
                reads: std::mem::take(&mut log.reads),
                writes: std::mem::take(&mut log.writes),
            }),
            Err(error) => Err(SqlError { error, denied: log.denied.take() }),
        }
    }
}

const SCHEMA_ONLY: &str = "schema.sql may only contain CREATE TABLE and CREATE INDEX statements";

impl Log {
    fn record(&mut self, ctx: AuthContext<'_>, policy: Policy) -> Result<(), String> {
        let schema = policy == Policy::Schema;
        let db = ctx.database_name.unwrap_or_default().to_lowercase();
        match ctx.action {
            AuthAction::Read { table_name, column_name } => {
                if !db.is_empty() {
                    let (table, column) = (table_name.to_lowercase(), column_name.to_lowercase());
                    self.reads.push(ColumnRead { db, table, column });
                }
                Ok(())
            }
            AuthAction::Insert { table_name }
            | AuthAction::Delete { table_name }
            | AuthAction::Update { table_name, .. } => {
                if schema && !table_name.starts_with("sqlite_") {
                    return Err(SCHEMA_ONLY.into());
                }
                self.writes.push(TableWrite { db, table: table_name.to_lowercase() });
                Ok(())
            }
            AuthAction::Function { function_name } if function_name.eq_ignore_ascii_case("load_extension") => {
                Err("load_extension is not allowed".into())
            }
            AuthAction::Select | AuthAction::Function { .. } | AuthAction::Recursive => Ok(()),
            AuthAction::CreateTable { .. } | AuthAction::CreateIndex { .. } | AuthAction::Reindex { .. } if schema => {
                Ok(())
            }
            AuthAction::CreateView { .. } if schema => {
                Err("stored views are not allowed in schema.sql; put each view in views/<name>.sql".into())
            }
            AuthAction::CreateTrigger { .. } if schema => Err("triggers are not allowed in schema.sql".into()),
            AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } => {
                Err("transactions are managed by the engine: each writer file already runs in one transaction".into())
            }
            action if schema => Err(format!("{SCHEMA_ONLY}, found {action:?}")),
            action => Err(format!("{action:?} is not allowed: SQL files may only SELECT, INSERT, UPDATE and DELETE")),
        }
    }
}
