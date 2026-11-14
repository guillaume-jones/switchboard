//! Forwards macOS sleep, wake, screen lock and network reachability to the engine as system events.

use block2::RcBlock;
use core_foundation::array::CFArray;
use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
use core_foundation::string::CFString;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSString};
use std::ptr::NonNull;
use std::thread;
use switchboard_core::SystemEvent;
use system_configuration::dynamic_store::{SCDynamicStore, SCDynamicStoreBuilder, SCDynamicStoreCallBackContext};

/// Present while the network has a primary service with an address.
const REACHABILITY_KEYS: [&str; 2] = ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"];

type OnEvent = Box<dyn Fn(SystemEvent) + Send>;

/// Observes for the app's lifetime. Call on the main thread, whose run loop delivers the notifications.
pub fn observe(on_event: impl Fn(SystemEvent) + Clone + Send + 'static) {
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
    thread::spawn(move || watch_reachability(on_event));
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
