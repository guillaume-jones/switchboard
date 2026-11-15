//! Forwards macOS sleep, wake, screen lock, idleness and network reachability to the engine as system events.

use block2::RcBlock;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
use core_foundation::string::CFString;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSString};
use std::ptr::{NonNull, null};
use std::thread;
use std::time::Duration;
use switchboard_core::SystemEvent;
use system_configuration::dynamic_store::{SCDynamicStore, SCDynamicStoreBuilder, SCDynamicStoreCallBackContext};

/// Present while the network has a primary service with an address.
const REACHABILITY_KEYS: [&str; 2] = ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"];
const IDLE_POLL: Duration = Duration::from_secs(15);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMCopyAssertionsStatus(status: *mut CFDictionaryRef) -> i32;
}

/// Takes ownership of a dictionary returned by a Copy function, if any.
fn owned(dictionary: CFDictionaryRef) -> Option<CFDictionary<CFString, CFType>> {
    (!dictionary.is_null()).then(|| unsafe { CFDictionary::wrap_under_create_rule(dictionary) })
}

pub fn locked() -> bool {
    owned(unsafe { CGSessionCopyCurrentDictionary() })
        .and_then(|session| session.find(CFString::from_static_string("CGSSessionScreenIsLocked")).map(|v| v.clone()))
        .and_then(|value| value.downcast::<CFBoolean>())
        .is_some_and(bool::from)
}

/// An app holds the display awake, as video players do; audio only keeps the system awake.
fn display_kept_awake() -> bool {
    let mut status = null();
    if unsafe { IOPMCopyAssertionsStatus(&mut status) } != 0 {
        return false;
    }
    owned(status)
        .and_then(|status| status.find(CFString::from_static_string("PreventUserIdleDisplaySleep")).map(|v| v.clone()))
        .and_then(|value| value.downcast::<CFNumber>())
        .and_then(|count| count.to_i64())
        .is_some_and(|count| count > 0)
}

/// No keyboard, pointer or scroll input for `after`, and nothing on screen being watched.
pub fn idle(after: Duration) -> bool {
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT: u32 = u32::MAX;
    let since_input = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT) };
    since_input >= after.as_secs_f64() && !display_kept_awake()
}

type OnEvent = Box<dyn Fn(SystemEvent) + Send>;

/// Observes for the app's lifetime. Call on the main thread, whose run loop delivers the notifications.
pub fn observe(
    on_event: impl Fn(SystemEvent) + Clone + Send + 'static,
    idle_after: impl Fn() -> Duration + Send + 'static,
) {
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    let distributed = NSDistributedNotificationCenter::defaultCenter();
    let (locked, unlocked) =
        (NSString::from_str("com.apple.screenIsLocked"), NSString::from_str("com.apple.screenIsUnlocked"));
    let observed: [(&NSNotificationCenter, &NSString, SystemEvent); 4] = unsafe {
        [
            (&workspace, NSWorkspaceWillSleepNotification, SystemEvent::Sleep),
            (&workspace, NSWorkspaceDidWakeNotification, SystemEvent::Wake),
            (&distributed, &locked, SystemEvent::Lock),
            (&distributed, &unlocked, SystemEvent::Unlock),
        ]
    };
    for (center, name, event) in observed {
        let on_event = on_event.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| on_event(event));
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
        std::mem::forget(observer);
    }
    let on_idle = on_event.clone();
    thread::spawn(move || watch_reachability(on_event));
    thread::spawn(move || {
        let mut was_idle = false;
        loop {
            let is_idle = idle(idle_after());
            if is_idle != was_idle {
                on_idle(if is_idle { SystemEvent::Idle } else { SystemEvent::Active });
                was_idle = is_idle;
            }
            thread::sleep(IDLE_POLL);
        }
    });
}

fn reachability(store: &SCDynamicStore) -> SystemEvent {
    match REACHABILITY_KEYS.iter().any(|key| store.get(*key).is_some()) {
        true => SystemEvent::Online,
        false => SystemEvent::Offline,
    }
}

fn changed(store: SCDynamicStore, _: CFArray<CFString>, on_event: &mut OnEvent) {
    on_event(reachability(&store));
}

/// Reports the current reachability, then every change, from a run loop on this thread.
fn watch_reachability(on_event: impl Fn(SystemEvent) + Clone + Send + 'static) {
    let context = SCDynamicStoreCallBackContext { callout: changed, info: Box::new(on_event.clone()) as OnEvent };
    let Some(store) = SCDynamicStoreBuilder::new("switchboard").callback_context(context).build() else { return };
    let keys: Vec<CFString> = REACHABILITY_KEYS.iter().map(|key| CFString::new(key)).collect();
    store.set_notification_keys(&CFArray::from_CFTypes(&keys), &CFArray::<CFString>::from_CFTypes(&[]));
    let Some(source) = store.create_run_loop_source() else { return };
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    on_event(reachability(&store));
    CFRunLoop::run_current();
}
