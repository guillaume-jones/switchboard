use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;
use switchboard_core::{Engine, Origin, Settings, SystemEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
mod notifications;
mod pty;
mod push;
mod remote;
#[cfg_attr(target_os = "macos", path = "system_events/macos.rs")]
#[cfg_attr(not(target_os = "macos"), path = "system_events/linux.rs")]
mod system_events;

pub(crate) struct App {
    engine: RwLock<Result<Engine, String>>,
    /// The window's subscriptions.
    subs: Mutex<HashSet<u64>>,
    remote: remote::Clients,
    ptys: pty::Ptys,
    /// Set once the board is served to other devices.
    push: OnceLock<push::Push>,
    hotkey: Mutex<String>,
    badge: Mutex<(String, u64)>,
    badge_count: AtomicUsize,
}

const IDLE_POLL: Duration = Duration::from_secs(15);

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
    app.state::<App>().badge_count.store(n, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count((n > 0).then_some(n as i64));
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(tray) = app.tray_by_id("switchboard") {
        let _ = tray.set_title(Some(if n == 0 { "○".into() } else { format!("● {n}") }));
    }
}

fn badge(app: &AppHandle) {
    let view = settings(app).map(|s| s.badge).unwrap_or_default();
    let state = app.state::<App>();
    let mut current = state.badge.lock().unwrap();
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
            "rows" if payload["id"] == self.0.state::<App>().badge.lock().unwrap().1 => {
                count(&self.0, &payload["rows"])
            }
            "notify" => {
                let (title, body) =
                    (payload["title"].as_str().unwrap_or_default(), payload["body"].as_str().unwrap_or_default());
                let settings = settings(&self.0);
                let focused = self.0.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false));
                #[cfg(target_os = "macos")]
                let shown =
                    focused || notifications::show(title, body, settings.as_ref().map_or("", |s| s.sound.as_str()));
                #[cfg(not(target_os = "macos"))]
                let shown = focused;
                if !shown {
                    let _ = self.0.notification().builder().title(title).body(body).show();
                }
                if settings.is_some_and(|s| push::wanted(&s)) {
                    let app = self.0.clone();
                    let badge = self.0.state::<App>().badge_count.load(Ordering::Relaxed);
                    let message = json!({ "title": payload["title"], "body": payload["body"], "badge": badge });
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<App>();
                        let Some(push) = state.push.get() else { return };
                        for error in push.send(message, state.remote.watching()).await {
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
                badge(&self.0);
            }
            _ => {}
        }
        if !self.0.state::<App>().remote.emit(event, &payload) {
            let _ = self.0.emit(event, payload);
        }
    }
}

/// Turns off WebKit's cap of page rendering near 60fps, so 120Hz displays scroll at their full rate. A private WebKit
/// feature flag: skipped if this WebKit no longer has it.
#[cfg(target_os = "macos")]
unsafe fn full_frame_rate(webview: *mut objc2::runtime::AnyObject) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSArray, NSString};
    let preferences_class = class!(WKPreferences);
    let supported: bool = unsafe { msg_send![preferences_class, respondsToSelector: sel!(_features)] };
    if webview.is_null() || !supported {
        return;
    }
    unsafe {
        let configuration: *mut AnyObject = msg_send![&*webview, configuration];
        let preferences: *mut AnyObject = msg_send![&*configuration, preferences];
        let features: *mut NSArray<AnyObject> = msg_send![preferences_class, _features];
        for feature in (*features).iter() {
            let key: *mut NSString = msg_send![&*feature, key];
            if (*key).to_string() == "PreferPageRenderingUpdatesNear60FPSEnabled" {
                let _: () = msg_send![&*preferences, _setEnabled: false, forFeature: &*feature];
            }
        }
    }
}

fn main() {
    let builder = tauri::Builder::default();
    // A second launch, such as from a desktop shortcut, shows this window instead; macOS does so itself with Reopen.
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .dbus_id(format!("dev.switchboard.app.home{:x}", {
                use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};
                BuildHasherDefault::<DefaultHasher>::default().hash_one(switchboard_core::home())
            }))
            .callback(|app, _, _| forward(app))
            .build(),
    );
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    let app = builder
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
            ptys: pty::Ptys::default(),
            push: OnceLock::new(),
            hotkey: Mutex::default(),
            badge: Mutex::default(),
            badge_count: AtomicUsize::new(0),
        })
        .invoke_handler(tauri::generate_handler![call, pty::pty_open, pty::pty_input, pty::pty_resize, pty::pty_close])
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                let state = webview.state::<App>();
                let ids: Vec<u64> = state.subs.lock().unwrap().drain().collect();
                state.ptys.close_all();
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
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let show = MenuItem::with_id(app, "show", "Show Switchboard", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                TrayIconBuilder::with_id("switchboard")
                    .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                    .title("○")
                    .tooltip("Switchboard")
                    .menu(&Menu::with_items(app, &[&show, &quit])?)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, e| match e.id.as_ref() {
                        "show" => forward(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, e| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left, button_state: MouseButtonState::Up, ..
                        } = e
                        {
                            forward(tray.app_handle())
                        }
                    })
                    .build(app)?;
            }
            #[cfg(all(target_os = "macos", not(debug_assertions)))]
            {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                let declined = app.path().app_data_dir()?.join("swb-declined");
                if let Ok(exe) = std::env::current_exe()
                    && !std::path::Path::new("/usr/local/bin/swb").exists()
                    && !declined.exists()
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        let install = handle
                            .dialog()
                            .message("Install the swb command-line tool in /usr/local/bin, so your terminal and agents can use it? macOS will ask for your password.")
                            .title("Install swb")
                            .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Not now".into()))
                            .blocking_show();
                        if !install {
                            let _ = fs::create_dir_all(declined.parent().unwrap()).and_then(|()| fs::write(&declined, ""));
                            return;
                        }
                        let script = format!(
                            "do shell script \"mkdir -p /usr/local/bin && ln -sf '{}' /usr/local/bin/swb\" with prompt \"Switchboard needs your password to install swb in /usr/local/bin.\" with administrator privileges",
                            exe.with_file_name("swb").display()
                        );
                        let _ = std::process::Command::new("osascript").args(["-e", &script]).status();
                    });
                }
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
            badge(&handle);
            hotkey(&handle);
            let on_event = {
                let handle = handle.clone();
                move |event| {
                    if let Ok(engine) = &*handle.state::<App>().engine.read().unwrap() {
                        engine.system_event(event);
                    }
                }
            };
            system_events::observe(on_event.clone());
            let idle_handle = handle.clone();
            std::thread::spawn(move || {
                let mut was_idle = false;
                loop {
                    let idle_after = settings(&idle_handle).map_or(Duration::from_secs(120), |s| s.idle_after);
                    let is_idle = system_events::idle(idle_after);
                    if is_idle != was_idle {
                        on_event(if is_idle { SystemEvent::Idle } else { SystemEvent::Active });
                        was_idle = is_idle;
                    }
                    std::thread::sleep(IDLE_POLL);
                }
            });
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| unsafe { full_frame_rate(webview.inner().cast()) });
            }
            #[cfg(target_os = "macos")]
            notifications::init({
                let handle = handle.clone();
                move || forward(&handle)
            });
            let _ = app.notification().on_action(move |_| forward(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("cannot start Switchboard");
    app.run(|app, e| match e {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => forward(app),
        RunEvent::Exit => {
            let engine = std::mem::replace(&mut *app.state::<App>().engine.write().unwrap(), Err("quit".into()));
            drop(engine);
        }
        _ => {}
    });
}
