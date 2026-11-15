//! Forwards logind sleep, wake and screen lock, desktop idleness and NetworkManager connectivity to the engine as
//! system events.

use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use switchboard_core::SystemEvent;
use zbus::blocking::{Connection, Proxy};

const LOGIND: &str = "org.freedesktop.login1";
const NETWORK_MANAGER: &str = "org.freedesktop.NetworkManager";
/// `NM_STATE_CONNECTED_SITE`: a default route, whether or not NetworkManager's connectivity check passes.
const NM_CONNECTED_SITE: u32 = 60;
/// `GSM_INHIBITOR_FLAG_IDLE`, which video players set while playing.
const GNOME_IDLE_INHIBITED: u32 = 8;

fn system_bus() -> Option<&'static Connection> {
    static BUS: OnceLock<Option<Connection>> = OnceLock::new();
    BUS.get_or_init(|| Connection::system().ok()).as_ref()
}

fn session_bus() -> Option<&'static Connection> {
    static BUS: OnceLock<Option<Connection>> = OnceLock::new();
    BUS.get_or_init(|| Connection::session().ok()).as_ref()
}

/// The graphical session this app runs in. Its real path, since property changes are signalled on that, not on `auto`.
fn login_session() -> Option<&'static Proxy<'static>> {
    static SESSION: OnceLock<Option<Proxy<'static>>> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            let bus = system_bus()?;
            let auto =
                Proxy::new(bus, LOGIND, "/org/freedesktop/login1/session/auto", "org.freedesktop.login1.Session")
                    .ok()?;
            let id: String = auto.get_property("Id").ok()?;
            let manager = Proxy::new(bus, LOGIND, "/org/freedesktop/login1", "org.freedesktop.login1.Manager").ok()?;
            let path: zbus::zvariant::OwnedObjectPath = manager.call("GetSession", &(id,)).ok()?;
            Proxy::new(bus, LOGIND, path, "org.freedesktop.login1.Session").ok()
        })
        .as_ref()
}

pub fn locked() -> bool {
    login_session().and_then(|session| session.get_property("LockedHint").ok()).unwrap_or(false)
}

/// On GNOME, no input for `after` and nothing on screen being watched. Elsewhere, the desktop's own idle hint, after
/// its own delay.
pub fn idle(after: Duration) -> bool {
    let gnome = session_bus().and_then(|bus| {
        let monitor = Proxy::new(
            bus,
            "org.gnome.Mutter.IdleMonitor",
            "/org/gnome/Mutter/IdleMonitor/Core",
            "org.gnome.Mutter.IdleMonitor",
        )
        .ok()?;
        let idle_ms: u64 = monitor.call("GetIdletime", &()).ok()?;
        let inhibited =
            Proxy::new(bus, "org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager")
                .and_then(|manager| manager.call("IsInhibited", &(GNOME_IDLE_INHIBITED,)))
                .unwrap_or(false);
        Some(Duration::from_millis(idle_ms) >= after && !inhibited)
    });
    gnome.unwrap_or_else(|| login_session().and_then(|s| s.get_property("IdleHint").ok()).unwrap_or(false))
}

/// Observes for the app's lifetime, each source on its own thread.
pub fn observe(on_event: impl Fn(SystemEvent) + Clone + Send + 'static) {
    let on_sleep = on_event.clone();
    thread::spawn(move || {
        let Some(bus) = system_bus() else { return };
        let Ok(manager) = Proxy::new(bus, LOGIND, "/org/freedesktop/login1", "org.freedesktop.login1.Manager") else {
            return;
        };
        let Ok(signals) = manager.receive_signal("PrepareForSleep") else { return };
        for signal in signals {
            if let Ok(sleeping) = signal.body().deserialize::<bool>() {
                on_sleep(if sleeping { SystemEvent::Sleep } else { SystemEvent::Wake });
            }
        }
    });
    let on_lock = on_event.clone();
    thread::spawn(move || {
        let Some(session) = login_session() else { return };
        let mut was_locked = locked();
        for change in session.receive_property_changed::<bool>("LockedHint") {
            if let Ok(is_locked) = change.get()
                && is_locked != was_locked
            {
                on_lock(if is_locked { SystemEvent::Lock } else { SystemEvent::Unlock });
                was_locked = is_locked;
            }
        }
    });
    thread::spawn(move || {
        let Some(bus) = system_bus() else { return };
        let Ok(network) = Proxy::new(bus, NETWORK_MANAGER, "/org/freedesktop/NetworkManager", NETWORK_MANAGER) else {
            return;
        };
        let reachability = |state: u32| match state >= NM_CONNECTED_SITE {
            true => SystemEvent::Online,
            false => SystemEvent::Offline,
        };
        let Ok(state) = network.get_property::<u32>("State") else { return };
        let mut was = reachability(state);
        on_event(was);
        for change in network.receive_property_changed::<u32>("State") {
            if let Ok(state) = change.get()
                && reachability(state) != was
            {
                was = reachability(state);
                on_event(was);
            }
        }
    });
}
