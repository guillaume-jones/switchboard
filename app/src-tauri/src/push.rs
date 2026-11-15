//! Web push to other devices' installed apps: `core.notify`, while the desktop is unattended per the `push` setting.
//! The VAPID key pair and the devices' subscriptions are kept in `data/push.json`; no card or rule reads them.

use base64ct::{Base64UrlUnpadded as Base64, Encoding};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use switchboard_core::Settings;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};
use web_push_native::{Auth, WebPushBuilder, p256::PublicKey};

pub(crate) struct Push {
    path: PathBuf,
    keys: ES256KeyPair,
    /// The VAPID `sub` claim: the board's own URL, rather than an address.
    contact: String,
    /// As returned by `PushManager.subscribe()`: `{endpoint, keys: {p256dh, auth}}`.
    subscriptions: Mutex<Vec<Value>>,
}

impl Push {
    /// Reads `data/push.json`, creating the key pair on first use.
    pub(crate) fn open(contact: String) -> Result<Push, String> {
        let path = switchboard_core::home().join("data/push.json");
        let saved: Value =
            fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let keys = saved["vapid"]
            .as_str()
            .and_then(|key| ES256KeyPair::from_bytes(&Base64::decode_vec(key).ok()?).ok())
            .unwrap_or_else(ES256KeyPair::generate);
        let subscriptions = saved["subscriptions"].as_array().cloned().unwrap_or_default();
        let push = Push { path, keys, contact, subscriptions: Mutex::new(subscriptions) };
        push.save()?;
        Ok(push)
    }

    fn save(&self) -> Result<(), String> {
        let saved = json!({
            "vapid": Base64::encode_string(&self.keys.to_bytes()),
            "subscriptions": *self.subscriptions.lock().unwrap(),
        });
        fs::write(&self.path, saved.to_string()).map_err(|e| e.to_string())
    }

    /// The application server key a device subscribes with.
    pub(crate) fn public_key(&self) -> String {
        Base64::encode_string(&self.keys.public_key().public_key().to_bytes_uncompressed())
    }

    pub(crate) fn subscribe(&self, subscription: Value) -> Result<(), String> {
        if subscription["endpoint"].as_str().is_none() {
            return Err("a push subscription needs an endpoint".into());
        }
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|s| s["endpoint"] != subscription["endpoint"]);
        subscriptions.push(subscription);
        drop(subscriptions);
        self.save()
    }

    fn request(&self, subscription: &Value, payload: &Value) -> Option<reqwest::Request> {
        let key = |name: &str| Base64::decode_vec(subscription["keys"][name].as_str()?).ok();
        let builder = WebPushBuilder::new(
            subscription["endpoint"].as_str()?.parse().ok()?,
            PublicKey::from_sec1_bytes(&key("p256dh")?).ok()?,
            Auth::clone_from_slice(&key("auth")?),
        )
        .with_vapid(&self.keys, &self.contact);
        let request = builder.build(payload.to_string()).ok()?;
        reqwest::Request::try_from(request.map(reqwest::Body::from)).ok()
    }

    /// Sends to every device, forgetting those whose push service says the subscription is gone.
    pub(crate) async fn send(&self, payload: Value) -> Vec<String> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();
        let subscriptions = self.subscriptions.lock().unwrap().clone();
        let mut errors = Vec::new();
        for subscription in subscriptions {
            let Some(request) = self.request(&subscription, &payload) else {
                errors.push(format!("invalid subscription {}", subscription["endpoint"]));
                continue;
            };
            match client.execute(request).await {
                Ok(r) if r.status().is_success() => {}
                Ok(r) if matches!(r.status().as_u16(), 404 | 410) => {
                    self.subscriptions.lock().unwrap().retain(|s| s["endpoint"] != subscription["endpoint"]);
                    errors.extend(self.save().err());
                }
                Ok(r) => errors.push(format!("{}: {}", r.status(), r.text().await.unwrap_or_default())),
                Err(e) => errors.push(e.to_string()),
            }
        }
        errors
    }
}

/// Whether the desktop counts as unattended for the `push` setting.
pub(crate) fn wanted(settings: &Settings) -> bool {
    use crate::system_events::{idle, locked};
    match settings.push.as_str() {
        "always" => true,
        "locked" => locked(),
        "idle" => locked() || idle(settings.idle_after),
        _ => false,
    }
}
