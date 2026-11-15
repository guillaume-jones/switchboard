//! The board for other devices: the shell and the same calls as IPC over HTTP, on a local port that
//! `tailscale serve` exposes as `https://<device>.<tailnet>.ts.net:<remote>` to the tailnet only.

use crate::{App, dispatch, with};
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

/// One open stream: a phone's app or a browser tab. Its subscriptions end with it.
pub(crate) struct Client {
    pub(crate) subs: Mutex<HashSet<u64>>,
    events: UnboundedSender<(String, Value)>,
}

#[derive(Default)]
pub(crate) struct Clients(Mutex<HashMap<String, Arc<Client>>>);

impl Clients {
    fn get(&self, id: &str) -> Option<Arc<Client>> {
        self.0.lock().unwrap().get(id).cloned()
    }

    /// Sends `rows` to the client that subscribed, and everything else to every client. False if no client
    /// owns these rows.
    pub(crate) fn emit(&self, event: &str, payload: &Value) -> bool {
        let clients = self.0.lock().unwrap();
        if event == "rows" {
            let id = payload["id"].as_u64().unwrap_or_default();
            let owner = clients.values().find(|c| c.subs.lock().unwrap().contains(&id));
            owner.map(|c| c.events.send((event.into(), payload.clone()))).is_some()
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
    let status: Value = serde_json::from_str(&tailscale(&["status", "--json"])?).map_err(|e| e.to_string())?;
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
    let router = Router::new()
        .route("/api/events", get(events))
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
        if client.is_none() && command == "subscribe" {
            return Err("no open event stream for this client".into());
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

/// Drops the client and its subscriptions when the stream closes.
struct Closed(AppHandle, String);

impl Drop for Closed {
    fn drop(&mut self) {
        let state = self.0.state::<App>();
        let Some(client) = state.remote.0.lock().unwrap().remove(&self.1) else { return };
        let ids: Vec<u64> = client.subs.lock().unwrap().drain().collect();
        if let Ok(engine) = &*state.engine.read().unwrap() {
            ids.into_iter().for_each(|id| engine.unsubscribe(id));
        }
    }
}

async fn events(State(app): State<AppHandle>) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    let (events, received) = unbounded_channel();
    let _ = events.send(("hello".to_string(), json!({ "client": id })));
    let client = Arc::new(Client { subs: Mutex::default(), events });
    app.state::<App>().remote.0.lock().unwrap().insert(id.clone(), client);
    let stream = futures_util::stream::unfold((received, Closed(app, id)), |(mut received, closed)| async move {
        let (event, payload) = received.recv().await?;
        Some((
            Ok::<_, std::convert::Infallible>(Event::default().event(event).data(payload.to_string())),
            (received, closed),
        ))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
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
