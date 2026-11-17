//! The loader: one function takes the folder and returns a loaded configuration or diagnostics. The engine calls
//! it on every change; `swb check` and the git pre-commit hook call it directly.

mod authorizer;
mod cards;
mod config;
mod schema;
mod sql_files;
mod sql_text;

pub use cards::CardBundle;
pub use config::{Action, FileWatch, Rule, Settings, SourceConfig, SystemEvent, Trigger, Watch};

use config::RuleContext;
use include_dir::{Dir, include_dir};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub(crate) const CORE_SOURCE: &str = "core";
static CORE_FILES: Dir = include_dir!("$CARGO_MANIFEST_DIR/core-source");

/// Commands implemented by the engine itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Builtin {
    Snapshot,
    Restore,
    Notify,
}

impl Builtin {
    const fn name(self) -> &'static str {
        match self {
            Builtin::Snapshot => "core.snapshot",
            Builtin::Restore => "core.restore",
            Builtin::Notify => "core.notify",
        }
    }

    pub(crate) fn parse(command: &str) -> Option<Builtin> {
        [Builtin::Snapshot, Builtin::Restore, Builtin::Notify].into_iter().find(|b| b.name() == command)
    }
}

pub const BUILTINS: [&str; 3] = [Builtin::Snapshot.name(), Builtin::Restore.name(), Builtin::Notify.name()];
/// Commands implemented by the shell, which key bindings may target.
pub const SHELL_COMMANDS: [&str; 4] = ["palette.open", "card.focus_next", "card.focus_prev", "keymap.context"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Only report: the databases are opened read-only.
    Check,
    /// Also apply the schema migrations once the whole folder passes.
    Apply,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// Relative to the folder, possibly with `:line:column`.
    pub path: String,
    pub message: String,
    pub level: Level,
}

impl Diagnostic {
    pub fn is_error(&self) -> bool {
        self.level == Level::Error
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let level = match self.level {
            Level::Error => "error",
            Level::Warning => "warning",
        };
        write!(f, "{}: {level}: {}", self.path, self.message)
    }
}

#[derive(Debug)]
pub struct Loaded {
    pub sources: BTreeMap<String, Source>,
    /// By view name, `<source>_<file>`.
    pub views: BTreeMap<String, Select>,
    /// By query name, `<source>.<file>`.
    pub queries: BTreeMap<String, Select>,
    pub writers: BTreeMap<String, Writer>,
    /// Command name → executable.
    pub commands: BTreeMap<String, PathBuf>,
    pub cards: BTreeMap<String, CardBundle>,
    pub rules: BTreeMap<String, Rule>,
    pub keymap: Vec<Value>,
    pub settings: Settings,
    /// The folder's git `HEAD`, recorded with runs, firings and events.
    pub commit: Option<String>,
    pub warnings: Vec<Diagnostic>,
}

impl Loaded {
    /// Whether `source.command` is listed in its source's `long_running`.
    pub fn is_long_running(&self, command: &str) -> bool {
        let (source, name) = command.split_once('.').unwrap_or((command, ""));
        self.sources.get(source).is_some_and(|s| s.config.long_running.contains(name))
    }
}

#[derive(Debug)]
pub struct Source {
    /// `data/<source>.db`, for a source with a `schema.sql`.
    pub db: Option<PathBuf>,
    pub config: SourceConfig,
}

/// A view or a query.
#[derive(Debug)]
pub struct Select {
    pub source: String,
    pub path: String,
    pub sql: String,
    pub columns: Vec<String>,
    /// Columns without a declared type, whose values keep the storage class of the expression.
    pub untyped_columns: BTreeSet<String>,
    /// Parameter names, without the `:`.
    pub params: Vec<String>,
    /// `source.table` of every table read through any depth of views: a write to one invalidates the result.
    pub tables: BTreeSet<String>,
    /// Reads the current time, directly or through a view, so its result can change without a write.
    pub time_dependent: bool,
}

#[derive(Debug)]
pub struct Writer {
    pub source: String,
    pub path: String,
    pub statements: Vec<Statement>,
    /// Every statement's parameters, without the `:`, in order of first appearance.
    pub params: Vec<String>,
    /// `source.table` of every table written.
    pub tables: BTreeSet<String>,
}

impl Writer {
    pub fn takes_payload(&self) -> bool {
        self.params.iter().any(|p| p == "payload")
    }
}

#[derive(Debug)]
pub struct Statement {
    pub sql: String,
    /// Parameter names, without the `:`, in binding order.
    pub params: Vec<String>,
}

/// The variables of a `{column}` template.
pub(crate) fn template_vars(template: &str) -> impl Iterator<Item = &str> {
    template.split('{').skip(1).filter_map(|part| part.split_once('}').map(|(var, _)| var))
}

#[derive(Default)]
struct Diagnostics(Vec<Diagnostic>);

impl Diagnostics {
    fn error(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.0.push(Diagnostic { path: path.into(), message: message.into(), level: Level::Error });
    }

    fn warn(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.0.push(Diagnostic { path: path.into(), message: message.into(), level: Level::Warning });
    }

    fn has_errors(&self) -> bool {
        self.0.iter().any(Diagnostic::is_error)
    }

    /// `Null` when the text is invalid, which is reported.
    fn parse_json(&mut self, path: &str, text: &str) -> Value {
        serde_json::from_str(text).unwrap_or_else(|e| {
            self.error(path, format!("invalid JSON: {e}"));
            Value::Null
        })
    }
}

/// A source's files by path relative to its folder; of `files/`, only the top level, to find views its scripts query.
struct SourceFiles {
    name: String,
    /// Shown in diagnostics.
    dir: String,
    files: BTreeMap<String, String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Folder,
    /// Only the embedded core source, for an app whose folder fails to load at startup.
    CoreOnly,
}

pub fn load(home: &Path, mode: Mode) -> Result<Loaded, Vec<Diagnostic>> {
    load_scoped(home, mode, Scope::Folder)
}

pub(crate) fn load_core_only(home: &Path, mode: Mode) -> Result<Loaded, Vec<Diagnostic>> {
    load_scoped(home, mode, Scope::CoreOnly)
}

fn load_scoped(home: &Path, mode: Mode, scope: Scope) -> Result<Loaded, Vec<Diagnostic>> {
    let mut diags = Diagnostics::default();
    let data = home.join("data");
    let folder_file = |rel: &str| match scope {
        Scope::Folder => fs::read_to_string(home.join(rel)).ok(),
        Scope::CoreOnly => None,
    };

    let source_files = read_sources(home, scope, &mut diags);
    let commands = collect_commands(home, &source_files, &mut diags);
    let schemas = schema::check(&source_files, &data, &mut diags);
    let sql_files::Checked { views, queries, writers, nested_views } =
        sql_files::check(&source_files, &schemas, &mut diags);

    let settings_text = folder_file("settings.json");
    let settings_json = settings_text.as_deref().map_or(Value::Null, |t| diags.parse_json("settings.json", t));
    let settings = Settings::parse(&settings_json, &mut diags);
    if !settings.badge.is_empty() && !views.contains_key(&settings.badge) {
        diags.error("settings.json", format!("badge: no view named {}", settings.badge));
    }
    if !settings.editing.is_empty() && !views.contains_key(&settings.editing) {
        diags.error("settings.json", format!("editing: no view named {}", settings.editing));
    }

    let card_modules = match scope {
        Scope::Folder => cards::read(home),
        Scope::CoreOnly => BTreeMap::new(),
    };
    let cards = cards::bundle(&card_modules, mode, &mut diags);
    let card_names: BTreeSet<&str> = cards.keys().map(String::as_str).collect();

    let mut sources = BTreeMap::new();
    for SourceFiles { name, dir, files } in &source_files {
        let json = files.get("source.json").map_or(Value::Null, |t| diags.parse_json(&format!("{dir}/source.json"), t));
        let config = SourceConfig::parse(name, &json, &card_names, &commands, &mut diags);
        sources.insert(name.clone(), Source { db: schemas.databases.get(name).cloned(), config });
    }

    let folder_rules: Vec<(String, String)> = match scope {
        Scope::Folder => crate::sorted_entries(&home.join("rules"))
            .into_iter()
            .filter(|(file, _)| file.ends_with(".json"))
            .map(|(file, path)| (format!("rules/{file}"), read_lossy(&path)))
            .collect(),
        Scope::CoreOnly => Vec::new(),
    };
    let source_rules = source_files.iter().flat_map(|s| {
        s.files
            .iter()
            .filter(|(rel, _)| rel.starts_with("rules/") && rel.ends_with(".json"))
            .map(|(rel, text)| (format!("{}/{rel}", s.dir), text.as_str()))
    });
    let rule_context = RuleContext { views: &views, writers: &writers, commands: &commands };
    let mut rule_ids = BTreeSet::new();
    let mut rules = BTreeMap::new();
    for (path, text) in source_rules.chain(folder_rules.iter().map(|(p, t)| (p.clone(), t.as_str()))) {
        let json = diags.parse_json(&path, text);
        if let Some(rule) = config::parse_rule(&path, &json, &rule_context, &mut rule_ids, &mut diags) {
            rules.insert(rule.id.clone(), rule);
        }
    }

    let keymap_text = folder_file("keymap.json");
    let keymap_json = keymap_text.as_deref().map_or(Value::Null, |t| diags.parse_json("keymap.json", t));
    let keymap = config::parse_keymap(keymap_json, &commands, &writers, &mut diags);

    let mentioning_texts: Vec<&str> = source_files
        .iter()
        .flat_map(|s| s.files.iter())
        .filter(|(rel, _)| {
            rel.starts_with("commands/")
                || rel.starts_with("files/")
                || (rel.starts_with("rules/") && rel.ends_with(".json"))
                || *rel == "source.json"
        })
        .map(|(_, text)| text.as_str())
        .chain(settings_text.as_deref())
        .chain(card_modules.values().map(String::as_str))
        .chain(folder_rules.iter().map(|(_, text)| text.as_str()))
        .chain(keymap_text.as_deref())
        .collect();
    let unnested = views.iter().filter(|(name, _)| !nested_views.contains(*name));
    for (name, select) in unnested.chain(&queries) {
        let used = mentioning_texts.iter().any(|text| sql_text::mentions_word(text, name));
        if select.source != CORE_SOURCE && !used {
            diags.warn(&select.path, format!("{name} is not used by any view, card, command, rule or key binding"));
        }
    }
    if scope == Scope::Folder && !cards.contains_key(&settings.root) {
        diags.warn(
            "cards",
            format!("the root card cards/{}.tsx does not exist, so the app shows nothing", settings.root),
        );
    }

    if diags.has_errors() {
        return Err(diags.0);
    }
    if mode == Mode::Apply {
        schema::apply(&schemas.migrations, home, &data, &mut diags);
        if diags.has_errors() {
            return Err(diags.0);
        }
    }
    Ok(Loaded {
        sources,
        views,
        queries,
        writers,
        commands,
        cards,
        rules,
        keymap,
        settings,
        commit: git_commit(home),
        warnings: diags.0,
    })
}

const SOURCE_ENTRIES: [&str; 8] =
    ["source.json", "schema.sql", "views", "queries", "writes", "commands", "rules", "files"];

fn read_sources(home: &Path, scope: Scope, diags: &mut Diagnostics) -> Vec<SourceFiles> {
    let core_files = CORE_FILES
        .files()
        .chain(CORE_FILES.dirs().flat_map(|d| d.files()))
        .map(|f| (f.path().to_string_lossy().into_owned(), f.contents_utf8().unwrap_or_default().to_string()))
        .collect();
    let mut sources = vec![SourceFiles { name: CORE_SOURCE.into(), dir: "(embedded core)".into(), files: core_files }];
    if scope == Scope::CoreOnly {
        return sources;
    }
    for (name, path) in crate::sorted_entries(&home.join("sources")).into_iter().filter(|(_, p)| p.is_dir()) {
        let dir = format!("sources/{name}");
        if [CORE_SOURCE, "main", "temp"].contains(&name.as_str()) {
            diags.error(dir, format!("source name {name} is reserved"));
            continue;
        }
        if !name.starts_with(|c: char| c.is_ascii_lowercase())
            || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            diags.error(dir, "source names must match [a-z][a-z0-9]*: views are named <source>_<file>, so a source name cannot contain '_'");
            continue;
        }
        for (entry, _) in
            crate::sorted_entries(&path).into_iter().filter(|(e, _)| !SOURCE_ENTRIES.contains(&e.as_str()))
        {
            diags.error(format!("{dir}/{entry}"), "unknown entry: a source folder may contain only source.json, schema.sql, views/, queries/, writes/, commands/, rules/ and files/ (for anything else its commands need)");
        }
        let mut files = BTreeMap::new();
        for rel in ["schema.sql", "source.json"] {
            let file = path.join(rel);
            if file.is_file() {
                files.insert(rel.to_string(), read_lossy(&file));
            }
        }
        for sub in ["views", "queries", "writes", "rules", "commands", "files"] {
            for (file, file_path) in crate::sorted_entries(&path.join(sub)).into_iter().filter(|(_, p)| p.is_file()) {
                files.insert(format!("{sub}/{file}"), read_lossy(&file_path));
            }
        }
        sources.push(SourceFiles { name, dir, files });
    }
    sources
}

fn collect_commands(home: &Path, sources: &[SourceFiles], diags: &mut Diagnostics) -> BTreeMap<String, PathBuf> {
    let mut commands = BTreeMap::new();
    for SourceFiles { name, dir, files } in sources {
        for file in files.keys().filter_map(|rel| rel.strip_prefix("commands/")) {
            let path = format!("{dir}/commands/{file}");
            let stem = file.split('.').next().unwrap_or(file);
            let valid_char = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_';
            if stem.is_empty() || !stem.chars().all(valid_char) {
                diags.error(&path, "command file names must be lowercase, like fix-ci or fix-ci.sh");
            }
            let executable = home.join(&path);
            if fs::metadata(&executable).is_ok_and(|m| m.permissions().mode() & 0o111 == 0) {
                diags.error(&path, format!("command is not executable: chmod +x {path}"));
            }
            let command = format!("{name}.{stem}");
            if commands.insert(command.clone(), executable).is_some() {
                diags.error(&path, format!("another file in {dir}/commands/ also defines the command {command}"));
            }
        }
    }
    commands
}

/// The file's text, with invalid UTF-8 replaced; empty when it cannot be read.
fn read_lossy(path: &Path) -> String {
    String::from_utf8_lossy(&fs::read(path).unwrap_or_default()).into_owned()
}

fn git_commit(home: &Path) -> Option<String> {
    let git = home.join(".git");
    let head = fs::read_to_string(git.join("HEAD")).ok()?;
    let Some(branch) = head.trim().strip_prefix("ref: ") else {
        return Some(head.trim().into());
    };
    fs::read_to_string(git.join(branch)).ok().map(|s| s.trim().to_string()).or_else(|| {
        fs::read_to_string(git.join("packed-refs"))
            .ok()?
            .lines()
            .find_map(|line| line.strip_suffix(branch)?.strip_suffix(' ').map(String::from))
    })
}
