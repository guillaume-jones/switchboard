use switchboard_core::{Engine, Origin, Settings};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

mod push;
mod remote;
#[cfg(target_os = "macos")]
mod system_events;

pub(crate) struct App {
    engine: RwLock<Result<Engine, String>>,
    /// The window's subscriptions.
    subs: Mutex<HashSet<u64>>,
    remote: remote::Clients,
    /// Set once the board is served to other devices.
    push: OnceLock<push::Push>,
    hotkey: Mutex<String>,
    menu_bar: Mutex<(String, u64)>,
}

pub(crate) type Reply = Result<Value, String>;

pub(crate) fn with(app: &App, f: impl FnOnce(&Engine) -> anyhow::Result<Value>) -> Reply {
    match &*app.engine.read().unwrap() {
        Ok(engine) => f(engine).map_err(|e| format!("{e:#}")),
        Err(e) => Err(e.clone()),
    }
}

/// Every call the shell makes, from the window over IPC or from another device over HTTP. `subs` are the caller's
/// subscriptions, dropped when it goes away.
pub(crate) fn dispatch(app: &App, subs: &Mutex<HashSet<u64>>, command: &str, args: Value, trigger: &str) -> Reply {
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_string();
    let params = |key: &str| if args[key].is_null() { json!({}) } else { args[key].clone() };
    let origin = || Origin { trigger: trigger.into(), run_id: None };
    with(app, |e| match command {
        "config" => Ok(e.config()),
        "card" => e.card(&text("name")),
        "subscribe" => {
            let (id, rows) = e.subscribe(&text("name"), params("params"))?;
            subs.lock().unwrap().insert(id);
            Ok(json!({ "id": id, "rows": rows }))
        }
        "unsubscribe" => {
            let id = args["id"].as_u64().unwrap_or_default();
            subs.lock().unwrap().remove(&id);
            e.unsubscribe(id);
            Ok(Value::Null)
        }
        "mutate" => Ok(json!({ "changes": e.write(&text("name"), params("params"), origin())? })),
        "run" => {
            let run_id = match args["id"].as_str() {
                Some(id) => e.run_as(id, &text("name"), params("args"), origin())?,
                None => e.run(&text("name"), params("args"), origin())?,
            };
            Ok(json!({ "run_id": run_id }))
        }
        "revert_last_commit" => e.revert_last_commit().map(|()| Value::Null),
        "report_error" => {
            e.report_error(&text("card"), &text("message"), &text("stack"));
            Ok(Value::Null)
        }
        _ => anyhow::bail!("unknown command {command}"),
    })
}

#[tauri::command(async)]
fn call(app: State<App>, command: String, args: Value) -> Reply {
    dispatch(&app, &app.subs, &command, args, "app")
}

fn forward(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn settings(app: &AppHandle) -> Option<Settings> {
    app.state::<App>().engine.read().unwrap().as_ref().ok().map(|e| e.loaded().settings.clone())
}

fn count(app: &AppHandle, rows: &Value) {
    let n = rows.as_array().map_or(0, Vec::len);
    if let Some(tray) = app.tray_by_id("switchboard") {
        let _ = tray.set_title(Some(if n == 0 { "○".into() } else { format!("● {n}") }));
    }
}

fn menu_bar(app: &AppHandle) {
    let view = settings(app).map(|s| s.menu_bar).unwrap_or_default();
    let state = app.state::<App>();
    let mut current = state.menu_bar.lock().unwrap();
    let Ok(engine) = &*state.engine.read().unwrap() else { return };
    if current.0 == view {
        return;
    }
    engine.unsubscribe(current.1);
    let (id, rows) = match view.as_str() {
        "" => (0, Value::Null),
        v => engine.subscribe(v, json!({})).unwrap_or((0, Value::Null)),
    };
    count(app, &rows);
    *current = (view, id);
}

fn hotkey(app: &AppHandle) {
    let key = settings(app).map(|s| s.hotkey.replace('-', "+")).unwrap_or_default();
    let state = app.state::<App>();
    let mut current = state.hotkey.lock().unwrap();
    if *current == key {
        return;
    }
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if !key.is_empty()
        && let Err(e) = shortcuts.register(key.as_str())
        && let Ok(engine) = &*state.engine.read().unwrap()
    {
        engine.error("hotkey", "settings.json", &format!("hotkey {key}: {e}"));
    }
    *current = key;
}

struct Forward(AppHandle);

impl switchboard_core::Emitter for Forward {
    fn emit(&self, event: &str, payload: Value) {
        match event {
            "rows" if payload["id"] == self.0.state::<App>().menu_bar.lock().unwrap().1 => {
                count(&self.0, &payload["rows"])
            }
            "notify" => {
                let n = self.0.notification().builder();
                let _ = n
                    .title(payload["title"].as_str().unwrap_or_default())
                    .body(payload["body"].as_str().unwrap_or_default())
                    .show();
                if settings(&self.0).is_some_and(|s| push::wanted(&s)) {
                    let app = self.0.clone();
                    let message = json!({ "title": payload["title"], "body": payload["body"] });
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<App>();
                        let Some(push) = state.push.get() else { return };
                        for error in push.send(message).await {
                            let _ = with(&state, |e| {
                                e.error("push", "core.notify", &error);
                                Ok(Value::Null)
                            });
                        }
                    });
                }
            }
            "config" => {
                hotkey(&self.0);
                menu_bar(&self.0);
            }
            _ => {}
        }
        if !self.0.state::<App>().remote.emit(event, &payload) {
            let _ = self.0.emit(event, payload);
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, e| {
                    if e.state == ShortcutState::Pressed {
                        forward(app)
                    }
                })
                .build(),
        )
        .manage(App {
            engine: RwLock::new(Err("starting".into())),
            subs: Mutex::default(),
            remote: remote::Clients::default(),
            push: OnceLock::new(),
            hotkey: Mutex::default(),
            menu_bar: Mutex::default(),
        })
        .invoke_handler(tauri::generate_handler![call])
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                let state = webview.state::<App>();
                let ids: Vec<u64> = state.subs.lock().unwrap().drain().collect();
                if let Ok(engine) = &*state.engine.read().unwrap() {
                    ids.into_iter().for_each(|id| engine.unsubscribe(id));
                }
            }
        })
        .on_window_event(|window, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            TrayIconBuilder::with_id("switchboard")
                .title("○")
                .tooltip("Switchboard")
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left, button_state: MouseButtonState::Up, ..
                    } = e
                    {
                        forward(tray.app_handle())
                    }
                })
                .build(app)?;
            #[cfg(not(debug_assertions))]
            if let Ok(exe) = std::env::current_exe()
                && !std::path::Path::new("/usr/local/bin/swb").exists()
            {
                let script = format!(
                    "do shell script \"mkdir -p /usr/local/bin && ln -sf '{}' /usr/local/bin/swb\" with prompt \"Switchboard wants to install its swb command.\" with administrator privileges",
                    exe.with_file_name("swb").display()
                );
                let _ = std::process::Command::new("osascript").args(["-e", &script]).spawn();
            }
            let handle = app.handle().clone();
            let home = switchboard_core::home();
            let opened = Engine::open(&home, Forward(handle.clone())).map_err(|e| format!("{e:#}"));
            if opened.is_ok() {
                let _ = fs::write(home.join("cards/switchboard.d.ts"), include_str!("../../switchboard.d.ts"));
                let tsconfig = home.join("tsconfig.json");
                if !tsconfig.exists() {
                    let _ = fs::write(tsconfig, include_str!("../../../template/tsconfig.json"));
                }
            }
            *app.state::<App>().engine.write().unwrap() = opened;
            if let Some(port) = settings(&handle).and_then(|s| s.remote) {
                remote::start(handle.clone(), port);
            }
            menu_bar(&handle);
            hotkey(&handle);
            #[cfg(target_os = "macos")]
            {
                let handle = handle.clone();
                let settings_handle = handle.clone();
                system_events::observe(
                    move |event| {
                        if let Ok(engine) = &*handle.state::<App>().engine.read().unwrap() {
                            engine.system_event(event);
                        }
                    },
                    move || settings(&settings_handle).map_or(std::time::Duration::from_secs(120), |s| s.idle_after),
                );
            }
            let _ = app.notification().on_action(move |_| forward(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("cannot start Switchboard");
    app.run(|app, e| match e {
        RunEvent::Reopen { .. } => forward(app),
        RunEvent::Exit => {
            let engine = std::mem::replace(&mut *app.state::<App>().engine.write().unwrap(), Err("quit".into()));
            drop(engine);
        }
        _ => {}
    });
}
