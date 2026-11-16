//! Cards and `cards/lib/`, compiled with oxc from TypeScript and JSX into modules the webview evaluates.

use super::sql_text::location;
use super::{Diagnostics, Mode};
use oxc::allocator::Allocator;
use oxc::ast::{AstKind, ast};
use oxc::codegen::Codegen;
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use oxc::transformer_plugins::ModuleRunnerTransform;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Module path relative to `cards/` (`Root.tsx`, `lib/format.ts`) → compiled JavaScript.
pub type CardBundle = BTreeMap<String, String>;

const RUNTIME_MODULES: [&str; 3] = ["react", "react/jsx-runtime", "switchboard"];
const LIB_EXTENSIONS: [&str; 3] = [".ts", ".tsx", ".js"];

/// Top-level `*.tsx` cards and everything under `cards/lib/`, keyed by their path relative to `cards/`.
pub(super) fn read(home: &Path) -> BTreeMap<String, String> {
    let mut modules = BTreeMap::new();
    let mut dirs = vec![String::new()];
    while let Some(dir) = dirs.pop() {
        let in_lib = dir.starts_with("lib/");
        for (file, path) in crate::sorted_entries(&home.join("cards").join(&dir)) {
            let rel = format!("{dir}{file}");
            if path.is_dir() && (rel == "lib" || in_lib) {
                dirs.push(format!("{rel}/"));
                continue;
            }
            let is_module = if in_lib {
                LIB_EXTENSIONS.iter().any(|e| file.ends_with(e))
            } else {
                dir.is_empty() && file.ends_with(".tsx")
            };
            if path.is_file() && is_module {
                modules.insert(rel, super::read_lossy(&path));
            }
        }
    }
    modules
}

/// Compiles every module and bundles each card with the lib modules it imports, directly or not. When applying, a
/// module that fails to compile only warns, and is replaced by one throwing its errors when a card evaluates it.
pub(super) fn bundle(
    modules: &BTreeMap<String, String>,
    mode: Mode,
    diags: &mut Diagnostics,
) -> BTreeMap<String, CardBundle> {
    let names: BTreeSet<String> = modules.keys().cloned().collect();
    let mut compiled = BTreeMap::new();
    for (rel, text) in modules {
        match compile(rel, text, &names) {
            Ok(module) => _ = compiled.insert(rel.as_str(), module),
            Err(errors) => {
                let path = format!("cards/{rel}");
                let errors: Vec<String> = errors
                    .into_iter()
                    .map(|(offset, message)| {
                        let at = location(&path, text, offset);
                        match mode {
                            Mode::Check => diags.error(&at, &message),
                            Mode::Apply => diags.warn(&at, &message),
                        }
                        format!("{at}: {message}")
                    })
                    .collect();
                let js = format!("throw new Error({})", serde_json::to_string(&errors.join("\n")).unwrap());
                compiled.insert(rel.as_str(), CompiledModule { js, imports: Vec::new() });
            }
        }
    }
    let mut cards = BTreeMap::new();
    for card in names.iter().filter(|rel| !rel.contains('/')) {
        let mut bundle = CardBundle::new();
        let mut pending = vec![card.as_str()];
        while let Some(rel) = pending.pop() {
            if let Some(module) = compiled.get(rel).filter(|_| !bundle.contains_key(rel)) {
                bundle.insert(rel.to_string(), module.js.clone());
                pending.extend(module.imports.iter().map(String::as_str));
            }
        }
        cards.insert(card.trim_end_matches(".tsx").to_string(), bundle);
    }
    cards
}

struct CompiledModule {
    js: String,
    /// Lib modules imported, by path relative to `cards/`.
    imports: Vec<String>,
}

/// Errors are byte offsets into `text` with a message.
fn compile(rel: &str, text: &str, modules: &BTreeSet<String>) -> Result<CompiledModule, Vec<(usize, String)>> {
    let alloc = Allocator::default();
    let mut parsed = Parser::new(&alloc, text, SourceType::from_path(rel).unwrap_or_default()).parse();
    let located = |diagnostics: &[OxcDiagnostic]| -> Vec<(usize, String)> {
        diagnostics
            .iter()
            .map(|e| (e.labels.first().map_or(0, |l| l.offset() as usize), e.message.to_string()))
            .collect()
    };
    if !parsed.diagnostics.is_empty() {
        return Err(located(&parsed.diagnostics));
    }
    let semantic = SemanticBuilder::new().with_check_syntax_error(true).with_build_nodes(true).build(&parsed.program);
    let mut errors = located(&semantic.diagnostics);
    errors.extend(semantic.semantic.nodes().iter().filter_map(|n| match n.kind() {
        AstKind::ImportExpression(e) => {
            Some((e.span.start as usize, "dynamic import() is not supported: use a static import".into()))
        }
        AstKind::ImportMeta(m) => Some((m.span.start as usize, "import.meta is not available in cards".into())),
        _ => None,
    }));
    let scoping = semantic.semantic.into_scoping();
    let mut imports = Vec::new();
    let importer_dir = rel.rsplit_once('/').map_or("", |(dir, _)| dir);
    for statement in parsed.program.body.iter_mut() {
        let source = match statement {
            ast::Statement::ImportDeclaration(d) => &mut d.source,
            ast::Statement::ExportAllDeclaration(d) => &mut d.source,
            ast::Statement::ExportFromDeclaration(d) => &mut d.source,
            _ => continue,
        };
        let spec = source.value.as_str().unwrap_or_default();
        match resolve_import(importer_dir, spec, modules) {
            Ok(Import::Runtime) => {}
            Ok(Import::Lib(target)) => {
                source.value = alloc.alloc_str(&target).into();
                imports.push(target);
            }
            Err(message) => errors.push((source.span.start as usize, message)),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let transformed = Transformer::new(&alloc, Path::new(rel), &TransformOptions::default())
        .build_with_scoping(scoping, &mut parsed.program);
    if !transformed.diagnostics.is_empty() {
        return Err(located(&transformed.diagnostics));
    }
    ModuleRunnerTransform::new().transform(&alloc, &mut parsed.program, transformed.scoping);
    Ok(CompiledModule { js: Codegen::new().build(&parsed.program).code, imports })
}

enum Import {
    /// Provided by the webview.
    Runtime,
    Lib(String),
}

fn resolve_import(importer_dir: &str, spec: &str, modules: &BTreeSet<String>) -> Result<Import, String> {
    if RUNTIME_MODULES.contains(&spec) {
        return Ok(Import::Runtime);
    }
    if !spec.starts_with(['.', '/']) {
        return Err(format!(
            "imports \"{spec}\": npm packages are not supported yet; cards may import react, react/jsx-runtime, switchboard and files under cards/lib/"
        ));
    }
    let mut parts = Vec::new();
    let mut escapes_cards = spec.starts_with('/');
    for part in importer_dir.split('/').chain(spec.split('/')) {
        match part {
            "" | "." => {}
            ".." => escapes_cards |= parts.pop().is_none(),
            part => parts.push(part),
        }
    }
    let target = parts.join("/");
    let found = ["", ".ts", ".tsx", ".js"].iter().map(|e| format!("{target}{e}")).find(|t| modules.contains(t));
    match found.filter(|_| !escapes_cards) {
        Some(module) if module.starts_with("lib/") => Ok(Import::Lib(module)),
        Some(card) if !card.contains('/') => Err(format!(
            "imports the card {0}: cards cannot import each other; compose with <CardSlot component=\"{0}\" />",
            card.trim_end_matches(".tsx")
        )),
        None if !escapes_cards && target.starts_with("lib/") => {
            Err(format!("imports \"{spec}\": no file cards/{target} with extension .ts, .tsx or .js"))
        }
        _ => {
            Err(format!("imports \"{spec}\", which is outside cards/lib/: only files under cards/lib/ can be imported"))
        }
    }
}
