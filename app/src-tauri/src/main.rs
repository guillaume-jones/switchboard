use switchboard_core::{Engine, Origin, Settings};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::sync::{Mutex, RwLock};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
mod system_events;

struct App {
    engine: RwLock<Result<Engine, String>>,
    subs: Mutex<HashSet<u64>>,
    hotkey: Mutex<String>,
    menu_bar: Mutex<(String, u64)>,
}

type Reply = Result<Value, String>;

fn with(app: &App, f: impl FnOnce(&Engine) -> anyhow::Result<Value>) -> Reply {
    match &*app.engine.read().unwrap() {
        Ok(engine) => f(engine).map_err(|e| format!("{e:#}")),
        Err(e) => Err(e.clone()),
    }
}

fn origin() -> Origin {
    Origin { trigger: "app".into(), run_id: None }
}

#[tauri::command(async)]
fn config(app: State<App>) -> Reply {
    with(&app, |e| Ok(e.config()))
}

#[tauri::command(async)]
fn card(app: State<App>, name: String) -> Reply {
    with(&app, |e| e.card(&name))
}

#[tauri::command(async)]
fn subscribe(app: State<App>, name: String, params: Value) -> Reply {
    with(&app, |e| {
        let (id, rows) = e.subscribe(&name, params)?;
        app.subs.lock().unwrap().insert(id);
        Ok(json!({ "id": id, "rows": rows }))
    })
}

#[tauri::command(async)]
fn unsubscribe(app: State<App>, id: u64) -> Reply {
    app.subs.lock().unwrap().remove(&id);
    with(&app, |e| {
        e.unsubscribe(id);
        Ok(Value::Null)
    })
}

#[tauri::command(async)]
fn mutate(app: State<App>, name: String, params: Value) -> Reply {
    with(&app, |e| Ok(json!({ "changes": e.write(&name, params, origin())? })))
}

#[tauri::command(async)]
fn run(app: State<App>, name: String, args: Value) -> Reply {
    with(&app, |e| Ok(json!({ "run_id": e.run(&name, args, origin())? })))
}

#[tauri::command(async)]
fn revert_last_commit(app: State<App>) -> Reply {
    with(&app, |e| e.revert_last_commit().map(|_| Value::Null))
}

#[tauri::command(async)]
fn report_error(app: State<App>, card: String, message: String, stack: String) -> Reply {
    with(&app, |e| {
        e.report_error(&card, &message, &stack);
        Ok(Value::Null)
    })
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
            }
            "config" => {
                hotkey(&self.0);
                menu_bar(&self.0);
            }
            _ => {}
        }
        let _ = self.0.emit(event, payload);
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
            hotkey: Mutex::default(),
            menu_bar: Mutex::default(),
        })
        .invoke_handler(tauri::generate_handler![
            config,
            card,
            subscribe,
            unsubscribe,
            mutate,
            run,
            revert_last_commit,
            report_error
        ])
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
            menu_bar(&handle);
            hotkey(&handle);
            #[cfg(target_os = "macos")]
            {
                let handle = handle.clone();
                system_events::observe(move |event| {
                    if let Ok(engine) = &*handle.state::<App>().engine.read().unwrap() {
                        engine.system_event(event);
                    }
                });
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
