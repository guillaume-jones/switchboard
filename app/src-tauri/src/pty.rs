//! Terminals of `pty` runs for the window: output streams over a channel, input and resizes come as calls.

use crate::App;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use switchboard_core::Pty;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Default)]
pub(crate) struct Ptys {
    open: Mutex<HashMap<u64, Pty>>,
    next: AtomicU64,
}

impl Ptys {
    /// Closes every terminal, when the window reloads.
    pub(crate) fn close_all(&self) {
        self.open.lock().unwrap().drain().for_each(|(_, pty)| pty.close());
    }

    fn with(&self, id: u64, f: impl FnOnce(&mut Pty) -> std::io::Result<()>) -> Result<(), String> {
        let mut open = self.open.lock().unwrap();
        let pty = open.get_mut(&id).ok_or("this terminal is closed")?;
        f(pty).map_err(|e| e.to_string())
    }
}

pub(crate) fn connect(app: &App, run: &str) -> Result<Pty, String> {
    match &*app.engine.read().unwrap() {
        Ok(engine) => engine.pty(run).map_err(|e| format!("{e:#}")),
        Err(e) => Err(e.clone()),
    }
}

/// Sends the terminal's output to `output` as raw bytes, then an empty message once it closes.
#[tauri::command(async)]
pub(crate) fn pty_open(app: State<App>, run: String, output: Channel<InvokeResponseBody>) -> Result<u64, String> {
    let pty = connect(&app, &run)?;
    let mut reader = pty.try_clone().map_err(|e| e.to_string())?;
    let id = app.ptys.next.fetch_add(1, Ordering::Relaxed);
    app.ptys.open.lock().unwrap().insert(id, pty);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 << 10];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if output.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        let _ = output.send(InvokeResponseBody::Raw(Vec::new()));
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn pty_input(app: State<App>, id: u64, data: String) -> Result<(), String> {
    app.ptys.with(id, |pty| pty.input(data.as_bytes()))
}

#[tauri::command]
pub(crate) fn pty_resize(app: State<App>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    app.ptys.with(id, |pty| pty.resize(cols, rows))
}

#[tauri::command]
pub(crate) fn pty_close(app: State<App>, id: u64) {
    if let Some(pty) = app.ptys.open.lock().unwrap().remove(&id) {
        pty.close();
    }
}
