//! The JSON files: `settings.json`, `source.json`, rules and `keymap.json`.

use super::{BUILTINS, Diagnostics, SHELL_COMMANDS, Select, Writer, template_vars};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Settings {
    /// Runs a rule with `when.view` or `when.files` may start per hour before it is blocked and disabled.
    pub max_per_hour: u32,
    pub max_depth: u32,
    /// Rule runs in the `running` state at once.
    pub max_concurrency: u32,
    pub timeout: Duration,
    pub open_run_expiry: Duration,
    /// How long the network must stay unreachable before `offline` fires.
    pub offline_debounce: Duration,
    pub snapshot_interval: Duration,
    pub snapshot_retention: Duration,
    /// How long events and finished runs are kept.
    pub retention: Duration,
    /// Maximum nesting of card slots, enforced by the shell.
    pub depth_cap: u32,
    pub root: String,
    pub terminal: String,
    pub hotkey: String,
    /// A view whose row count is shown in the menu bar; empty for none.
    pub menu_bar: String,
    /// The HTTPS port `tailscale serve` exposes the board on to other devices; `None` keeps it local.
    pub remote: Option<u16>,
    /// How long another device may hold a run it queued while offline before it is dropped instead of sent.
    pub queue_run_expiry: Duration,
}

const SETTINGS: &str = "settings.json";

fn positive_integer(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0)
}

fn positive_count(value: &Value) -> Option<u32> {
    positive_integer(value).and_then(|n| u32::try_from(n).ok())
}

const COUNT_TOO_LARGE: &str = " (at most 4294967295)";

impl Settings {
    /// `json` is the parsed file, or `Null` when it is absent or invalid.
    pub(super) fn parse(json: &Value, diags: &mut Diagnostics) -> Settings {
        let empty = Map::new();
        let fields = match json {
            Value::Object(fields) => fields,
            Value::Null => &empty,
            _ => {
                diags.error(SETTINGS, "must be a JSON object");
                &empty
            }
        };
        let mut count = |key: &str, default: u32| match fields.get(key) {
            None => default,
            Some(v) => positive_count(v).unwrap_or_else(|| {
                let range = if positive_integer(v).is_some() { COUNT_TOO_LARGE } else { "" };
                diags.error(SETTINGS, format!("{key} must be a positive integer{range}"));
                default
            }),
        };
        let (max_per_hour, max_depth, max_concurrency, depth_cap) =
            (count("max_per_hour", 20), count("max_depth", 5), count("max_concurrency", 4), count("depth_cap", 20));
        let mut seconds = |key: &str, default: u64| match fields.get(key) {
            None => Duration::from_secs(default),
            Some(v) => Duration::from_secs(positive_integer(v).unwrap_or_else(|| {
                diags.error(SETTINGS, format!("{key} must be a positive integer"));
                default
            })),
        };
        let (timeout, open_run_expiry, offline_debounce, snapshot_interval, snapshot_retention, retention) = (
            seconds("timeout", 600),
            seconds("open_run_expiry", 86_400),
            seconds("offline_debounce", 3),
            seconds("snapshot_interval", 3_600),
            seconds("snapshot_retention", 604_800),
            seconds("retention", 2_592_000),
        );
        let queue_run_expiry = seconds("queue_run_expiry", 3_600);
        let remote = fields.get("remote").and_then(|v| {
            let port = positive_integer(v).and_then(|n| u16::try_from(n).ok());
            if port.is_none() {
                diags.error(SETTINGS, "remote must be a port number (1 to 65535)");
            }
            port
        });
        let mut text = |key: &str, default: &str| match fields.get(key) {
            None => default.to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                diags.error(SETTINGS, format!("{key} must be a string"));
                default.to_string()
            }
        };
        Settings {
            max_per_hour,
            max_depth,
            max_concurrency,
            timeout,
            open_run_expiry,
            offline_debounce,
            snapshot_interval,
            snapshot_retention,
            retention,
            depth_cap,
            root: text("root", "Root"),
            terminal: text("terminal", "Terminal"),
            hotkey: text("hotkey", "cmd-shift-space"),
            menu_bar: text("menu_bar", ""),
            remote,
            queue_run_expiry,
        }
    }
}

/// `source.json`.
#[derive(Clone, Debug, Default)]
pub struct SourceConfig {
    /// The card that renders this source's refs.
    pub item_card: Option<String>,
    pub snapshot_interval: Option<Duration>,
    pub snapshot_retention: Option<Duration>,
    /// Command name (without the source prefix) → timeout.
    pub timeouts: BTreeMap<String, Duration>,
    /// Command name (without the source prefix) → how long it may wait in another device's outbox; zero for never.
    pub queue_expiry: BTreeMap<String, Duration>,
}

impl SourceConfig {
    pub(super) fn parse(
        source: &str,
        json: &Value,
        cards: &BTreeSet<&str>,
        commands: &BTreeMap<String, PathBuf>,
        diags: &mut Diagnostics,
    ) -> SourceConfig {
        let path = format!("sources/{source}/source.json");
        let mut config = SourceConfig::default();
        let fields = match json {
            Value::Object(fields) => fields,
            Value::Null => return config,
            _ => {
                diags.error(path, "must be a JSON object");
                return config;
            }
        };
        for (key, value) in fields {
            let valid = match key.as_str() {
                "item_card" => {
                    config.item_card = value.as_str().filter(|c| cards.contains(c)).map(String::from);
                    config.item_card.is_some()
                }
                "snapshot_interval" => {
                    config.snapshot_interval = positive_integer(value).map(Duration::from_secs);
                    config.snapshot_interval.is_some()
                }
                "snapshot_retention" => {
                    config.snapshot_retention = positive_integer(value).map(Duration::from_secs);
                    config.snapshot_retention.is_some()
                }
                "timeouts" | "queue_expiry" => {
                    let allows_zero = key == "queue_expiry";
                    let seconds = value.as_object().and_then(|entries| {
                        entries
                            .iter()
                            .map(|(command, seconds)| {
                                let known = commands.contains_key(&format!("{source}.{command}"));
                                let seconds = seconds.as_u64().filter(|n| known && (allows_zero || *n > 0))?;
                                Some((command.clone(), Duration::from_secs(seconds)))
                            })
                            .collect::<Option<BTreeMap<_, _>>>()
                    });
                    let valid = seconds.is_some();
                    let seconds = seconds.unwrap_or_default();
                    if allows_zero {
                        config.queue_expiry = seconds
                    } else {
                        config.timeouts = seconds
                    }
                    valid
                }
                _ => {
                    diags.error(
                        &path,
                        format!(
                            "unknown field {key} (expected item_card, snapshot_interval, snapshot_retention, timeouts, queue_expiry)"
                        ),
                    );
                    continue;
                }
            };
            if !valid {
                let expected = match key.as_str() {
                    "item_card" => "the name of a card in cards/",
                    "timeouts" => "an object mapping this source's command names to seconds",
                    "queue_expiry" => "an object mapping this source's command names to seconds (0 for never)",
                    _ => "a positive number of seconds",
                };
                diags.error(&path, format!("{key} must be {expected}"));
            }
        }
        config
    }
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub path: String,
    pub watch: Option<Watch>,
    pub trigger: Option<Trigger>,
    pub action: Action,
    /// Values may be `{column}` templates, rendered from the row that fired.
    pub args: Map<String, Value>,
    pub max_per_hour: Option<u32>,
    pub timeout: Option<Duration>,
    /// `log: false` skips its firing rows and write events; errors and blocked firings are still recorded.
    pub log: bool,
}

/// `when.view`, and the `key` template rendered for each of its rows: a rule fires once per new key.
#[derive(Debug, Clone)]
pub struct Watch {
    pub view: String,
    pub key: String,
}

/// What makes a rule fire besides its view changing. With `when.view`, an occurrence re-evaluates the view;
/// alone, the rule fires once per occurrence.
#[derive(Debug, Clone)]
pub enum Trigger {
    Schedule(Box<croner::Cron>),
    Files(FileWatch),
    System(SystemEvent),
}

impl Trigger {
    /// The template variables an occurrence provides to a rule without `when.view`.
    pub(crate) fn vars(&self) -> &'static [&'static str] {
        match self {
            Trigger::Schedule(_) => &[],
            Trigger::Files(FileWatch { line_contains: None, .. }) => &["path"],
            Trigger::Files(_) => &["path", "line"],
            Trigger::System(_) => &["event"],
        }
    }
}

/// `when.files`: fires once a matching file has changed and gone quiet. With `when.line_contains`, fires once per
/// line appended to it that contains the text instead.
#[derive(Debug, Clone)]
pub struct FileWatch {
    pub pattern: glob::Pattern,
    /// The deepest directory of the pattern without wildcards, watched recursively.
    pub root: PathBuf,
    pub line_contains: Option<String>,
}

impl FileWatch {
    const MATCH: glob::MatchOptions = glob::MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };

    fn parse(text: &str, line_contains: Option<String>) -> Result<FileWatch, String> {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let path = text.strip_prefix("~/").map_or_else(|| PathBuf::from(text), |rest| home.join(rest));
        if !path.is_absolute() {
            return Err(format!("when.files {text:?} must be an absolute path or start with ~/"));
        }
        let wildcard = |c: &Component| c.as_os_str().to_string_lossy().contains(['*', '?', '[']);
        let root: PathBuf = path.components().take_while(|c| !wildcard(c)).collect();
        let rest: PathBuf = path.components().skip_while(|c| !wildcard(c)).collect();
        // File events carry resolved paths, such as /private/var for /var.
        let root = root.canonicalize().unwrap_or(root);
        let pattern =
            glob::Pattern::new(&root.join(rest).to_string_lossy()).map_err(|e| format!("when.files {text:?}: {e}"))?;
        Ok(FileWatch { pattern, root, line_contains })
    }

    pub(crate) fn matches(&self, path: &Path) -> bool {
        self.pattern.matches_path_with(path, Self::MATCH)
    }

    /// The files matching the pattern right now.
    pub(crate) fn existing(&self) -> impl Iterator<Item = PathBuf> {
        glob::glob_with(self.pattern.as_str(), Self::MATCH).into_iter().flatten().flatten()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemEvent {
    Sleep,
    Wake,
    Lock,
    Unlock,
    Online,
    Offline,
}

impl SystemEvent {
    pub const ALL: [SystemEvent; 6] = [
        SystemEvent::Sleep,
        SystemEvent::Wake,
        SystemEvent::Lock,
        SystemEvent::Unlock,
        SystemEvent::Online,
        SystemEvent::Offline,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SystemEvent::Sleep => "sleep",
            SystemEvent::Wake => "wake",
            SystemEvent::Lock => "lock",
            SystemEvent::Unlock => "unlock",
            SystemEvent::Online => "online",
            SystemEvent::Offline => "offline",
        }
    }

    pub fn parse(event: &str) -> Option<SystemEvent> {
        SystemEvent::ALL.into_iter().find(|e| e.as_str() == event)
    }
}

#[derive(Debug, Clone)]
pub enum Action {
    /// `run`: starts a command; with `into`, that writer receives the command's stdout as `:payload`.
    Run { command: String, into: Option<String> },
    /// `into` alone: calls the writer with the rule's args.
    Write { writer: String },
}

pub(super) struct RuleContext<'a> {
    pub views: &'a BTreeMap<String, Select>,
    pub writers: &'a BTreeMap<String, Writer>,
    pub commands: &'a BTreeMap<String, PathBuf>,
}

const RULE_FIELDS: [&str; 9] = ["id", "when", "key", "run", "into", "args", "max_per_hour", "timeout", "log"];
const WHEN_FIELDS: [&str; 5] = ["view", "schedule", "files", "line_contains", "system"];
const TRIGGER_FIELDS: [&str; 3] = ["schedule", "files", "system"];

/// Parses one rule file. Problems are reported and make it return `None`.
pub(super) fn parse_rule(
    path: &str,
    json: &Value,
    context: &RuleContext,
    ids: &mut BTreeSet<String>,
    diags: &mut Diagnostics,
) -> Option<Rule> {
    let Some(fields) = json.as_object() else {
        if !json.is_null() {
            diags.error(path, "a rule must be a JSON object");
        }
        return None;
    };
    let mut problems = Vec::new();
    for key in fields.keys().filter(|k| !RULE_FIELDS.contains(&k.as_str())) {
        problems.push(format!("unknown field {key} (expected {})", RULE_FIELDS.join(", ")));
    }
    let text = |key: &str| fields.get(key).and_then(Value::as_str).map(String::from);
    let when = fields.get("when").and_then(Value::as_object);
    let when_text = |key: &str| when.and_then(|w| w.get(key)).and_then(Value::as_str).map(String::from);
    let (id, view, key, run, into) = (text("id"), when_text("view"), text("key"), text("run"), text("into"));
    if let Some(k) = when.into_iter().flatten().map(|(k, _)| k).find(|k| !WHEN_FIELDS.contains(&k.as_str())) {
        problems.push(format!("unknown field when.{k} (expected {})", WHEN_FIELDS.join(", ")));
    }
    match &id {
        None => problems.push("id is required".into()),
        Some(id) if !ids.insert(id.clone()) => problems.push(format!("rule id {id} is already used by another rule")),
        Some(_) => {}
    }
    let triggers: Vec<(&str, String)> =
        TRIGGER_FIELDS.into_iter().filter_map(|field| Some((field, when_text(field)?))).collect();
    let line_contains = when_text("line_contains");
    if line_contains.is_some() && when_text("files").is_none() {
        problems.push("when.line_contains needs when.files".into());
    }
    let trigger = match triggers.as_slice() {
        [] => None,
        [("schedule", s)] => s
            .parse()
            .map(|cron| Trigger::Schedule(Box::new(cron)))
            .map_err(|e| problems.push(format!("when.schedule {s:?}: {e}")))
            .ok(),
        [("files", f)] => FileWatch::parse(f, line_contains).map(Trigger::Files).map_err(|e| problems.push(e)).ok(),
        [("system", e)] => SystemEvent::parse(e).map(Trigger::System).or_else(|| {
            let expected = SystemEvent::ALL.map(SystemEvent::as_str).join(", ");
            problems.push(format!("when.system {e:?} is not a system event (expected {expected})"));
            None
        }),
        _ => {
            let fields = triggers.iter().map(|(f, _)| format!("when.{f}")).collect::<Vec<_>>().join(", ");
            problems.push(format!("a rule takes at most one trigger, got {fields}"));
            None
        }
    };
    if view.is_none() && triggers.is_empty() {
        problems.push(format!("when needs a view, a trigger ({}), or both", TRIGGER_FIELDS.join(", ")));
    }
    let watched = view.as_ref().and_then(|v| {
        let select = context.views.get(v);
        if select.is_none() {
            problems.push(format!("when.view {v} does not exist"));
        }
        select
    });
    match (&view, &key) {
        (Some(_), None) => problems.push("key is required for a rule with when.view, e.g. \"{id}\"".into()),
        (None, Some(_)) => {
            problems.push("key needs when.view; without one a rule fires once per trigger occurrence".into())
        }
        _ => {}
    }
    if let Some(r) = run.as_ref().filter(|r| !context.commands.contains_key(*r) && !BUILTINS.contains(&r.as_str())) {
        problems.push(format!("run: no command named {r}"));
    }
    let args = match fields.get("args") {
        None => Map::new(),
        Some(Value::Object(args)) => args.clone(),
        Some(_) => {
            problems.push("args must be an object".into());
            Map::new()
        }
    };
    let writer = into.as_ref().and_then(|w| context.writers.get(w));
    match (&run, &into, writer) {
        (None, None, _) => problems.push("a rule needs run, into, or both".into()),
        (_, Some(w), None) => problems.push(format!("into: no writer named {w}")),
        (Some(_), Some(w), Some(writer)) if !writer.takes_payload() => {
            problems.push(format!("into: writer {w} has no :payload param to receive the command's stdout"))
        }
        (None, Some(w), Some(writer)) => {
            let wanted: BTreeSet<&String> = writer.params.iter().filter(|p| *p != "run_id").collect();
            let given: BTreeSet<&String> = args.keys().collect();
            if wanted != given {
                problems.push(format!(
                    "args must provide exactly the params of {w}: {}",
                    wanted.iter().map(|p| format!(":{p}")).collect::<Vec<_>>().join(", ")
                ));
            }
        }
        _ => {}
    }
    let trigger_vars = trigger.as_ref().map_or(&[][..], Trigger::vars);
    let templates = key.iter().map(String::as_str).chain(args.values().filter_map(Value::as_str));
    for var in templates.flat_map(template_vars) {
        match watched {
            Some(select) if !select.columns.iter().any(|c| c == var) => problems.push(format!(
                "{{{var}}} is not a column of {} (columns: {})",
                view.as_deref().unwrap_or_default(),
                select.columns.join(", ")
            )),
            None if view.is_none() && trigger_vars.contains(&var) => {}
            None if trigger_vars.is_empty() => problems.push(format!("{{{var}}} needs when.view to take values from")),
            None => problems
                .push(format!("{{{var}}} is not a variable of the trigger (variables: {})", trigger_vars.join(", "))),
            Some(_) => {}
        }
    }
    let max_per_hour = fields.get("max_per_hour").and_then(|value| {
        let count = positive_count(value);
        if count.is_none() {
            let range = if positive_integer(value).is_some() { COUNT_TOO_LARGE } else { "" };
            problems.push(format!("max_per_hour must be a positive integer{range}"));
        }
        count
    });
    let timeout = fields.get("timeout").and_then(|value| {
        let seconds = positive_integer(value);
        if seconds.is_none() {
            problems.push("timeout must be a positive integer".into());
        }
        seconds
    });
    let log = match fields.get("log") {
        None => true,
        Some(Value::Bool(log)) => *log,
        Some(_) => {
            problems.push("log must be true or false".into());
            true
        }
    };
    if !log && view.is_some() {
        problems.push("log: false needs a rule without when.view, whose firings remember the keys it fired".into());
    }
    let scheduled = matches!(trigger, Some(Trigger::Schedule(_)));
    if let Some(v) = view.as_ref().filter(|_| !scheduled && watched.is_some_and(|s| s.time_dependent)) {
        diags.warn(path, format!("{v} depends on the current time but the rule has no when.schedule, so it only re-evaluates after writes"));
    }
    for problem in &problems {
        diags.error(path, problem.clone());
    }
    if !problems.is_empty() {
        return None;
    }
    let action = match (run, into) {
        (Some(command), into) => Action::Run { command, into },
        (None, Some(writer)) => Action::Write { writer },
        (None, None) => return None,
    };
    Some(Rule {
        id: id?,
        path: path.into(),
        watch: view.zip(key).map(|(view, key)| Watch { view, key }),
        trigger,
        action,
        args,
        max_per_hour,
        timeout: timeout.map(Duration::from_secs),
        log,
    })
}

const BINDING_FIELDS: [&str; 5] = ["key", "context", "command", "write", "args"];

/// `json` is the parsed file, or `Null` when it is absent or invalid.
pub(super) fn parse_keymap(
    json: Value,
    commands: &BTreeMap<String, PathBuf>,
    writers: &BTreeMap<String, Writer>,
    diags: &mut Diagnostics,
) -> Vec<Value> {
    let bindings = match json {
        Value::Array(bindings) => bindings,
        Value::Null => return Vec::new(),
        _ => {
            diags.error("keymap.json", "must be an array of bindings");
            return Vec::new();
        }
    };
    for (i, binding) in bindings.iter().enumerate() {
        let path = format!("keymap.json[{i}]");
        let Some(fields) = binding.as_object() else {
            diags.error(path, "a binding must be an object like {\"key\": \"cmd-k\", \"command\": \"palette.open\"}");
            continue;
        };
        for k in fields.keys().filter(|k| !BINDING_FIELDS.contains(&k.as_str())) {
            diags.error(&path, format!("unknown field {k} (expected {})", BINDING_FIELDS.join(", ")));
        }
        if !fields.get("key").is_some_and(Value::is_string) {
            diags.error(&path, "key is required, like \"cmd-k\"");
        }
        if fields.get("context").is_some_and(|c| !c.is_string()) || fields.get("args").is_some_and(|a| !a.is_object()) {
            diags.error(&path, "context must be a string and args an object");
        }
        match (fields.get("command"), fields.get("write")) {
            (Some(_), Some(_)) | (None, None) => {
                diags.error(&path, "a binding needs exactly one of command or write (null unbinds)")
            }
            (Some(Value::String(c)), None)
                if !commands.contains_key(c)
                    && !BUILTINS.contains(&c.as_str())
                    && !SHELL_COMMANDS.contains(&c.as_str()) =>
            {
                diags.error(&path, format!("no command named {c} (shell commands: {})", SHELL_COMMANDS.join(", ")))
            }
            (None, Some(Value::String(w))) if !writers.contains_key(w) => {
                diags.error(&path, format!("no writer named {w}"))
            }
            (Some(Value::String(_) | Value::Null), None) | (None, Some(Value::String(_) | Value::Null)) => {}
            _ => diags.error(&path, "command and write must be a name or null"),
        }
    }
    bindings
}
