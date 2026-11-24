//! Lexical scans of SQL text, for the checks that preparing a statement cannot express.

use std::collections::HashSet;
use std::ffi::CString;

pub(super) fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Lowercased SQL with every string literal replaced by `''` and every comment by whitespace, so that scans only
/// see code.
pub(super) fn code_only(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                chars.by_ref().find(|&c| c == '\'');
                out.push_str("''");
            }
            '-' if chars.peek() == Some(&'-') => {
                chars.by_ref().find(|&c| c == '\n');
                out.push('\n');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
                out.push(' ');
            }
            c => out.push(c.to_ascii_lowercase()),
        }
    }
    out
}

/// Whether `text` contains `word` with no identifier character on either side.
pub(super) fn mentions_word(text: &str, word: &str) -> bool {
    text.match_indices(word)
        .any(|(i, _)| !text[..i].ends_with(is_word_char) && !text[i + word.len()..].starts_with(is_word_char))
}

/// Every run of identifier characters in `text`, and every two of them joined by a dot (`prs.search`): what
/// [`mentions_word`] finds of a view or query name, for many names in one pass over a large text.
pub(super) fn add_words<'a>(text: &'a str, words: &mut HashSet<&'a str>) {
    let bytes = text.as_bytes();
    let is_word = |i: usize| bytes.get(i).is_some_and(|&b| is_word_char(b as char));
    let (mut i, mut previous) = (0, None);
    while i < bytes.len() {
        if !is_word(i) {
            i += 1;
            continue;
        }
        let start = i;
        while is_word(i) {
            i += 1;
        }
        words.insert(&text[start..i]);
        if let Some(joined) = previous.filter(|&(_, end)| end + 1 == start && bytes[end] == b'.') {
            words.insert(&text[joined.0..i]);
        }
        previous = Some((start, i));
    }
}

/// Whether the SQL reads the current time: `'now'`, `CURRENT_*`, or a date function called without a time value.
pub(super) fn reads_current_time(sql: &str) -> bool {
    let code = code_only(sql);
    sql.to_lowercase().contains("'now'")
        || code.contains("current_date")
        || code.contains("current_time")
        || ["date", "time", "datetime", "julianday", "unixepoch"].iter().any(|f| time_value_omitted(&code, f, 0))
        || time_value_omitted(&code, "strftime", 1)
}

/// Whether some call of `function` has no argument at `time_value_index`, which makes SQLite default it to now.
fn time_value_omitted(code: &str, function: &str, time_value_index: usize) -> bool {
    let call = format!("{function}(");
    code.match_indices(&call).any(|(start, _)| {
        !code[..start].ends_with(is_word_char) && argument_count(&code[start + call.len()..]) <= time_value_index
    })
}

fn argument_count(after_open_paren: &str) -> usize {
    let (mut depth, mut commas, mut empty) = (0usize, 0, true);
    for c in after_open_paren.chars() {
        match c {
            ')' if depth == 0 => break,
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => commas += 1,
            c if !c.is_whitespace() => empty = false,
            _ => {}
        }
    }
    if empty { 0 } else { commas + 1 }
}

/// Whether the code selects `*` or `table.*`, given the output of [`code_only`].
pub(super) fn selects_star(code: &str) -> bool {
    code.match_indices('*').any(|(i, _)| {
        let before = code[..i].trim_end();
        before.ends_with(['.', ','])
            || ["select", "distinct", "all"]
                .iter()
                .any(|keyword| before.strip_suffix(keyword).is_some_and(|rest| !rest.ends_with(is_word_char)))
    })
}

pub(super) fn has_top_level_comma(code: &str) -> bool {
    let mut depth = 0i32;
    code.chars().any(|c| {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        c == ',' && depth == 0
    })
}

/// The first word, unquoted and lowercased: the column name of a column definition.
pub(super) fn first_identifier(code: &str) -> String {
    code.split_whitespace().next().unwrap_or_default().trim_matches(['"', '`', '[', ']']).to_lowercase()
}

/// Splits a file into its statements, each with its byte offset in `sql`. Empty statements are dropped.
pub(super) fn split_statements(sql: &str) -> Vec<(usize, &str)> {
    let mut statements = Vec::new();
    let mut start = 0;
    for (end, _) in sql.match_indices(';') {
        let candidate = &sql[start..=end];
        // SAFETY: `sqlite3_complete` only reads the NUL-terminated string, which outlives the call.
        let complete =
            CString::new(candidate).is_ok_and(|c| unsafe { rusqlite::ffi::sqlite3_complete(c.as_ptr()) } != 0);
        if complete {
            statements.push((start, candidate));
            start = end + 1;
        }
    }
    statements.push((start, &sql[start..]));
    statements.retain(|(_, s)| !code_only(s).trim().trim_matches(';').trim().is_empty());
    statements
}

/// The definition of `column` in a `CREATE TABLE` statement, for `ALTER TABLE ADD COLUMN`. Only found when the
/// column is defined on its own line.
pub(super) fn column_definition(create_table: &str, column: &str) -> Option<String> {
    let body = &create_table[create_table.find('(')? + 1..];
    body.lines().find_map(|line| {
        let mut definition = line.split("--").next()?.trim().trim_end_matches(',').trim_end();
        // The last column's line may also close the table: drop unbalanced closing parentheses.
        while definition.matches(')').count() > definition.matches('(').count() {
            definition = definition[..definition.rfind(')')?].trim_end().trim_end_matches(',');
        }
        (first_identifier(definition) == column && !has_top_level_comma(definition)).then(|| definition.to_string())
    })
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone)]
pub(super) struct DeprecatedItem {
    pub table: String,
    pub column: Option<String>,
}

pub(super) struct Deprecation {
    pub line: usize,
    pub item: DeprecatedItem,
    pub note: String,
}

/// `-- @deprecated <note>` comments in a schema: on a column's line, on a `CREATE TABLE` line, or on its own line
/// directly above a `CREATE TABLE`. Returns the deprecations and the (1-based) lines of misplaced comments.
pub(super) fn deprecations(schema: &str) -> (Vec<Deprecation>, Vec<(usize, &'static str)>) {
    let mut found = Vec::new();
    let mut misplaced = Vec::new();
    let mut table = String::new();
    let mut pending_table_note: Option<(usize, String)> = None;
    for (index, line) in schema.lines().enumerate() {
        let line_number = index + 1;
        let (code, comment) = line.split_once("--").unwrap_or((line, ""));
        let note = comment.split_once("@deprecated").map(|(_, n)| n.trim().to_string());
        let code = code.trim();
        if code.is_empty() {
            if pending_table_note.is_none() {
                pending_table_note = note.map(|n| (line_number, n));
            }
            continue;
        }
        let lower = code.to_lowercase();
        if let Some(rest) = lower.strip_prefix("create table") {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix("if not exists").unwrap_or(rest).trim_start();
            let name = rest.split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or_default();
            table = name.rsplit('.').next().unwrap_or_default().trim_matches(['"', '`', '[', ']']).to_string();
            if let Some(note) = pending_table_note.take().map(|(_, n)| n).or(note) {
                let item = DeprecatedItem { table: table.clone(), column: None };
                found.push(Deprecation { line: line_number, item, note });
            }
            continue;
        }
        if let Some((comment_line, _)) = pending_table_note.take() {
            misplaced
                .push((comment_line, "an @deprecated comment on its own line must be directly above a CREATE TABLE"));
        }
        if let Some(note) = note {
            let definition = code.trim_end_matches(',');
            if has_top_level_comma(definition) {
                misplaced.push((line_number, "@deprecated needs one column per line"));
            } else {
                let item = DeprecatedItem { table: table.clone(), column: Some(first_identifier(definition)) };
                found.push(Deprecation { line: line_number, item, note });
            }
        }
    }
    (found, misplaced)
}

/// `path:line:col` of a byte offset into `text`, or just `path` when the offset is out of range.
pub(super) fn location(path: &str, text: &str, offset: usize) -> String {
    let Some(before) = text.get(..offset) else { return path.into() };
    let line = before.matches('\n').count() + 1;
    let column = before[before.rfind('\n').map_or(0, |i| i + 1)..].chars().count() + 1;
    format!("{path}:{line}:{column}")
}
