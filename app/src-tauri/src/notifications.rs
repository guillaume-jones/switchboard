//! macOS notifications through UserNotifications: with a sound, shown as banners even while the app is in
//! front, and clicking one calls back. Only an app bundle has a notification center, so `tauri dev` falls back.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

type OnClick = Box<dyn Fn() + Send + Sync>;

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = OnClick]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            _response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            (self.ivars())();
            handler.call(());
        }
    }
);

fn bundled() -> bool {
    NSBundle::mainBundle().bundlePath().to_string().ends_with(".app")
}

/// Asks for permission once and routes clicks to `on_click`. Call once at startup.
pub fn init(on_click: impl Fn() + Send + Sync + 'static) {
    if !bundled() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = Delegate::alloc().set_ivars(Box::new(on_click) as OnClick);
    let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives as long as the app.
    std::mem::forget(delegate);
    let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
    center.requestAuthorizationWithOptions_completionHandler(options, &RcBlock::new(|_: Bool, _: *mut NSError| {}));
}

/// Shows a notification with `sound` (a file name, or empty for the default), or returns false outside an app bundle.
pub fn show(title: &str, body: &str, sound: &str) -> bool {
    if !bundled() {
        return false;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let sound = if sound.is_empty() {
        UNNotificationSound::defaultSound()
    } else {
        UNNotificationSound::soundNamed(&NSString::from_str(sound))
    };
    content.setSound(Some(&sound));
    let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
    true
}
