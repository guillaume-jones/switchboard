//! The board for other devices: the shell and the same calls as IPC over HTTP, on a local port that
//! `tailscale serve` exposes as `https://<device>.<tailnet>.ts.net:<remote>` to the tailnet only.

use crate::push::Push;
use crate::{App, Reply, dispatch, with};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, BuildHasherDefault};
use std::io::Write;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

/// One open stream: a phone's app or a browser tab. Its subscriptions end with it.
pub(crate) struct Client {
    pub(crate) subs: Mutex<HashSet<u64>>,
    events: UnboundedSender<(String, Value)>,
    /// The push subscription endpoint of the device behind this stream.
    endpoint: Mutex<Option<String>>,
    /// Until when the app counts as on screen, renewed by its `presence` calls while it is.
    visible_until: Mutex<Option<Instant>>,
}

#[derive(Default)]
pub(crate) struct Clients(Mutex<HashMap<String, Arc<Client>>>);

impl Clients {
    fn get(&self, id: &str) -> Option<Arc<Client>> {
        self.0.lock().unwrap().get(id).cloned()
    }

    /// The push endpoints of devices showing the app now, which need no push.
    pub(crate) fn watching(&self) -> HashSet<String> {
        let now = Instant::now();
        let clients = self.0.lock().unwrap();
        clients
            .values()
            .filter(|c| c.visible_until.lock().unwrap().is_some_and(|until| until > now))
            .filter_map(|c| c.endpoint.lock().unwrap().clone())
            .collect()
    }

    /// Sends `rows`, with their digest, to the client that subscribed, and everything else to every client. False
    /// if no client owns these rows.
    pub(crate) fn emit(&self, event: &str, payload: &Value) -> bool {
        let clients = self.0.lock().unwrap();
        if event == "rows" {
            let id = payload["id"].as_u64().unwrap_or_default();
            let owner = clients.values().find(|c| c.subs.lock().unwrap().contains(&id));
            owner
                .map(|c| {
                    let mut payload = payload.clone();
                    payload["hash"] = digest(&payload["rows"]).into();
                    c.events.send((event.into(), payload))
                })
                .is_some()
        } else {
            clients.values().for_each(|c| _ = c.events.send((event.into(), payload.clone())));
            false
        }
    }
}

/// Who may connect: requests forwarded by `tailscale serve` for this device's name, from this device's user.
#[derive(Clone)]
struct Tailnet {
    host: String,
    port: u16,
    login: String,
}

const CLIENT_HEADER: &str = "switchboard-client";
const NO_STREAM: &str = "no open event stream for this client";
/// Larger, and the timing log starts over.
const LOG_LIMIT: u64 = 1 << 20;
/// How long a `presence` call keeps an app on screen; it repeats every 10 s while visible.
const PRESENCE_TTL: Duration = Duration::from_secs(25);

fn digest(value: &Value) -> String {
    format!("{:016x}", BuildHasherDefault::<DefaultHasher>::default().hash_one(value.to_string()))
}

/// Drops a client and its subscriptions.
fn close(state: &App, id: &str) {
    let Some(client) = state.remote.0.lock().unwrap().remove(id) else { return };
    let ids: Vec<u64> = client.subs.lock().unwrap().drain().collect();
    if let Ok(engine) = &*state.engine.read().unwrap() {
        ids.into_iter().for_each(|id| engine.unsubscribe(id));
    }
}

/// What a device's cache lacks: the config and cards whose digest differs from the `manifest`'s, and its
/// subscriptions, opened for this client, with their rows unless they match. Closes the device's `previous` client.
fn resync(state: &App, client: &Client, manifest: Value) -> Reply {
    if let Some(previous) = manifest["previous"].as_str() {
        close(state, previous);
    }
    with(state, |e| {
        let config = e.config();
        let config_hash = digest(&config);
        let mut cards = Map::new();
        for name in config["cards"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let modules = e.card(name)?;
            let hash = digest(&modules);
            if manifest["cards"][name] != hash {
                cards.insert(name.into(), json!({ "hash": hash, "modules": modules }));
            }
        }
        let subs: Vec<Value> = manifest["subs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|sub| {
                let params = if sub["params"].is_null() { json!({}) } else { sub["params"].clone() };
                match e.subscribe(sub["name"].as_str().unwrap_or_default(), params) {
                    Ok((id, rows)) => {
                        client.subs.lock().unwrap().insert(id);
                        let hash = digest(&rows);
                        let rows = if sub["hash"] == hash { Value::Null } else { rows };
                        json!({ "local": sub["local"], "id": id, "hash": hash, "rows": rows })
                    }
                    Err(error) => json!({ "local": sub["local"], "error": format!("{error:#}") }),
                }
            })
            .collect();
        let changed = manifest["config"] != config_hash;
        Ok(json!({
            "config": if changed { config } else { Value::Null },
            "config_hash": config_hash,
            "cards": cards,
            "subs": subs,
        }))
    })
}

/// Appends a device's reconnect timings to `data/remote.log`.
fn log(entry: Value) -> Reply {
    let path = switchboard_core::home().join("data/remote.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::remove_file(&path);
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(file, "{entry}").map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// `tailscale` from the app bundle's minimal PATH, Homebrew, the standalone CLI or the Mac app.
fn tailscale(args: &[&str]) -> Result<String, String> {
    let candidates = [
        "tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    let output = candidates
        .iter()
        .find_map(|bin| Command::new(bin).args(args).output().ok())
        .ok_or("tailscale is not installed")?;
    if !output.status.success() {
        return Err(format!("tailscale {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn tailnet(port: u16) -> Result<Tailnet, String> {
    let read_status = || -> Result<Value, String> {
        serde_json::from_str(&tailscale(&["status", "--json"])?).map_err(|e| e.to_string())
    };
    let mut status = read_status()?;
    if status["BackendState"] == "Stopped" {
        tailscale(&["up"])?;
        status = read_status()?;
    }
    let me = &status["Self"];
    let host = me["DNSName"].as_str().unwrap_or_default().trim_end_matches('.').to_string();
    let login = status["User"][me["UserID"].to_string()]["LoginName"].as_str().unwrap_or_default().to_string();
    if host.is_empty() || login.is_empty() {
        return Err("tailscale is not logged in".into());
    }
    Ok(Tailnet { host, port, login })
}

/// Serves until the app quits. Problems are recorded as `remote` errors and leave the app local-only.
pub(crate) fn start(app: AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        if let Err(message) = serve(app.clone(), port).await {
            let _ = with(&app.state::<App>(), |e| {
                e.error("remote", "settings.json", &message);
                Ok(Value::Null)
            });
        }
    });
}

async fn serve(app: AppHandle, port: u16) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let local = listener.local_addr().map_err(|e| e.to_string())?.port();
    let tailnet = tailnet(port)?;
    tailscale(&["serve", "--bg", &format!("--https={port}"), &format!("http://127.0.0.1:{local}")])?;
    let _ = app.state::<App>().push.set(Push::open(format!("https://{}:{port}", tailnet.host))?);
    let router = Router::new()
        .route("/api/events", get(events))
        .route("/api/pty/{run}", get(pty))
        .route("/api/{command}", post(call))
        .fallback(get(asset))
        .layer(middleware::from_fn_with_state(tailnet, authorize))
        .with_state(app);
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}

/// Identity, host and same-origin checks: the port is only reachable on this device, so anything without the
/// identity header `tailscale serve` sets did not come through it.
async fn authorize(State(tailnet): State<Tailnet>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let origin = format!("https://{}:{}", tailnet.host, tailnet.port);
    let host_ok = text("host") == tailnet.host || text("host") == format!("{}:{}", tailnet.host, tailnet.port);
    let api = request.uri().path().starts_with("/api/");
    let same_origin = (text("origin").is_empty() || text("origin") == origin)
        && matches!(text("sec-fetch-site"), "" | "same-origin" | "none");
    if text("tailscale-user-login") != tailnet.login || !host_ok || (api && !same_origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

async fn call(State(app): State<AppHandle>, Path(command): Path<String>, headers: HeaderMap, body: String) -> Response {
    let args: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let client = headers.get(CLIENT_HEADER).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let client = state.remote.get(&client);
        if client.is_none() && matches!(command.as_str(), "subscribe" | "resync") {
            return Err(NO_STREAM.into());
        }
        let push = || state.push.get().ok_or_else(|| "push is not available".to_string());
        match command.as_str() {
            "resync" => return resync(&state, client.as_ref().unwrap(), args),
            "log" => return log(args),
            "push_key" => return Ok(json!({ "key": push()?.public_key() })),
            "push_subscribe" => {
                if let Some(client) = &client {
                    *client.endpoint.lock().unwrap() = args["endpoint"].as_str().map(String::from);
                }
                return push()?.subscribe(args).map(|()| Value::Null);
            }
            "presence" => {
                let client = client.as_ref().ok_or(NO_STREAM)?;
                let visible = args["visible"].as_bool().unwrap_or(false);
                *client.visible_until.lock().unwrap() = visible.then(|| Instant::now() + PRESENCE_TTL);
                return Ok(Value::Null);
            }
            _ => {}
        }
        let unowned = Mutex::default();
        dispatch(&state, client.as_ref().map_or(&unowned, |c| &c.subs), &command, args, "remote")
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    match reply {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(json!({ "error": error }))).into_response(),
    }
}

/// A `pty` run's terminal over a websocket: binary messages of output; text messages of JSON, `{"input": text}` or
/// `{"resize": [cols, rows]}`. Closes when either side does.
async fn pty(State(app): State<AppHandle>, Path(run): Path<String>, upgrade: WebSocketUpgrade) -> Response {
    let connected = tauri::async_runtime::spawn_blocking(move || crate::pty::connect(&app.state::<App>(), &run)).await;
    let pty = match connected {
        Ok(Ok(pty)) => pty,
        Ok(Err(error)) => {
            return (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(json!({ "error": error }))).into_response();
        }
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    upgrade.on_upgrade(move |socket| relay(socket, pty))
}

async fn relay(mut socket: WebSocket, mut pty: switchboard_core::Pty) {
    let Ok(mut reader) = pty.try_clone() else { return };
    let (output, mut received) = unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 << 10];
        while let Ok(n @ 1..) = std::io::Read::read(&mut reader, &mut buf) {
            if output.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            chunk = received.recv() => {
                let Some(chunk) = chunk else { break };
                if socket.send(Message::Binary(chunk.into())).await.is_err() {
                    break;
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    let message: Value = serde_json::from_str(&text).unwrap_or_default();
                    let sent = match (&message["input"], &message["resize"]) {
                        (Value::String(input), _) => pty.input(input.as_bytes()),
                        (_, Value::Array(size)) => {
                            let dim = |i: usize| size.get(i).and_then(Value::as_u64).unwrap_or(0) as u16;
                            pty.resize(dim(0), dim(1))
                        }
                        _ => Ok(()),
                    };
                    if sent.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    pty.close();
}

/// Drops the client and its subscriptions when the stream closes.
struct Closed(AppHandle, String);

impl Drop for Closed {
    fn drop(&mut self) {
        close(&self.0.state::<App>(), &self.1);
    }
}

async fn events(State(app): State<AppHandle>) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    let (events, received) = unbounded_channel();
    let _ = events.send(("hello".to_string(), json!({ "client": id })));
    let client = Arc::new(Client {
        subs: Mutex::default(),
        events,
        endpoint: Mutex::default(),
        visible_until: Mutex::default(),
    });
    app.state::<App>().remote.0.lock().unwrap().insert(id.clone(), client);
    let stream = futures_util::stream::unfold((received, Closed(app, id)), |(mut received, closed)| async move {
        let (event, payload) = received.recv().await?;
        Some((
            Ok::<_, std::convert::Infallible>(Event::default().event(event).data(payload.to_string())),
            (received, closed),
        ))
    });
    let ping = Event::default().event("ping").data("{}");
    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(10)).event(ping))
}

async fn asset(State(app): State<AppHandle>, request: Request) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match app.asset_resolver().get(path.to_string()) {
        Some(asset) => {
            let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            let mut response = Response::new(Body::from(asset.bytes().to_vec()));
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, asset.mime_type().parse().unwrap());
            headers.insert(header::CACHE_CONTROL, cache.parse().unwrap());
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
