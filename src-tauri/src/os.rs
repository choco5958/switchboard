// What only the shell can do for the app logic (src/main/platform.ts): notifications, dialogs,
// the keychain, idle time, keeping the computer awake. Checks without a person at the screen
// (CLAUDE_IDE_CAPTURE_JS) touch none of them: no keychain prompt, no dialog, no notification.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub const SERVICE: &str = "io.github.choco5958.switchboard";

pub fn capturing() -> bool {
    std::env::var("CLAUDE_IDE_CAPTURE_JS").is_ok()
}

fn random_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system's random numbers");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

// The app key (src/main/appKey.ts) in the system's keychain. `lasting`: the next start finds the
// same key, which the terminal host needs. `refused`: the keychain said no; this run uses a key of
// its own and the saved one stays for a start that is allowed. `data`: the app's data folder, where
// the Electron app kept its key (electron_key), taken over at the first start after it.
pub fn app_key(data: &std::path::Path) -> Value {
    let fresh = || json!({ "key": random_key(), "refused": false, "lasting": false });
    if capturing() {
        return fresh();
    }
    // A check with a person at the screen (docs/tauri-이전.md) keeps its key in an entry of its own
    // (SERVICE.<name>), so the app's own entry stays as it was.
    let service = std::env::var("CLAUDE_IDE_KEYCHAIN_SERVICE").ok().filter(|name| name.strip_prefix(SERVICE).is_some_and(|rest| rest.len() > 1 && rest.starts_with('.'))).unwrap_or_else(|| SERVICE.to_string());
    let entry = match keyring::Entry::new(&service, "app-key") {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("keychain: no entry for the app key: {error}");
            return fresh();
        }
    };
    match entry.get_password() {
        Ok(key) if valid_key(&key) => json!({ "key": key, "refused": false, "lasting": true }),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let key = electron_key(data).unwrap_or_else(random_key);
            let saved = entry.set_password(&key);
            if let Err(error) = &saved {
                eprintln!("keychain: could not keep the app key: {error}");
            }
            json!({ "key": key, "refused": false, "lasting": saved.is_ok() })
        }
        Err(keyring::Error::NoStorageAccess(error)) => {
            eprintln!("keychain: refused: {error}");
            json!({ "key": random_key(), "refused": true, "lasting": false })
        }
        Err(error) => {
            eprintln!("keychain: could not read the app key: {error}");
            fresh()
        }
    }
}

// The key the Electron app kept (docs/tauri-이전.md, step 7): app-key.bin in the same data folder,
// sealed by Electron's safeStorage. Taking it over keeps the terminal host that app left running,
// with its terminals; without it the app starts its own and those terminals are not shown again.
// The seal is Chromium's: a version, then AES-128-CBC under a key derived (PBKDF2-SHA1, "saltysalt")
// from a password the system keeps for the app.
// - macOS: "v10", the password of the keychain item "claude-ide Safe Storage" (the keychain asks
//   the person once), 1003 rounds.
// - Linux: "v11", the secret service's item for the application "claude-ide" (GNOME keyring and
//   the like), 1 round. Without a secret service the Electron app kept no key (appKey.ts).
// - Windows has no terminal host to keep (termClient.ts hostSupported): nothing to take over.
#[cfg(target_os = "macos")]
fn electron_key(data: &std::path::Path) -> Option<String> {
    let sealed = std::fs::read(data.join("app-key.bin")).ok()?;
    let password = keyring::Entry::new("claude-ide Safe Storage", "claude-ide Key").ok()?.get_password().ok()?;
    let key = open_safe_storage(&password, sealed.strip_prefix(b"v10")?, 1003)?;
    valid_key(&key).then_some(key)
}

#[cfg(target_os = "linux")]
fn electron_key(data: &std::path::Path) -> Option<String> {
    use dbus_secret_service::{EncryptionType, SecretService};
    let sealed = std::fs::read(data.join("app-key.bin")).ok()?;
    let body = sealed.strip_prefix(b"v11")?;
    let service = SecretService::connect(EncryptionType::Dh).ok()?;
    let found = service.search_items(std::collections::HashMap::from([("application", "claude-ide")])).ok()?;
    let item = found.unlocked.into_iter().chain(found.locked).next()?;
    item.ensure_unlocked().ok()?;
    let password = String::from_utf8(item.get_secret().ok()?).ok()?;
    let key = open_safe_storage(&password, body, 1)?;
    valid_key(&key).then_some(key)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn electron_key(_data: &std::path::Path) -> Option<String> {
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_safe_storage(password: &str, body: &[u8], rounds: u32) -> Option<String> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", rounds, &mut key);
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into()).decrypt_padded_vec_mut::<Pkcs7>(body).ok()?;
    String::from_utf8(plain).ok()
}

// A confirmation: the index of the button pressed. Two buttons at most (all the logic asks).
pub fn message_box(app: &AppHandle, request: &Value) -> Value {
    let cancel = request["cancelId"].as_i64().unwrap_or(1);
    if capturing() {
        return json!(cancel);
    }
    let buttons: Vec<String> = request["buttons"].as_array().map(|b| b.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let text = match request["detail"].as_str() {
        Some(detail) if !detail.is_empty() => format!("{}\n\n{detail}", request["message"].as_str().unwrap_or("")),
        _ => request["message"].as_str().unwrap_or("").to_string(),
    };
    let kind = match request["type"].as_str() {
        Some("warning") => MessageDialogKind::Warning,
        Some("error") => MessageDialogKind::Error,
        _ => MessageDialogKind::Info,
    };
    let dialog = app.dialog().message(text).title("Switchboard").kind(kind);
    let pressed_first = match buttons.as_slice() {
        [] => dialog.blocking_show(),
        [only] => dialog.buttons(MessageDialogButtons::OkCustom(only.clone())).blocking_show(),
        [first, second, ..] => dialog.buttons(MessageDialogButtons::OkCancelCustom(first.clone(), second.clone())).blocking_show(),
    };
    json!(if pressed_first { 0 } else { cancel.max(1) })
}

pub fn pick_folder(app: &AppHandle, title: &str) -> Value {
    if capturing() {
        return Value::Null;
    }
    match app.dialog().file().set_title(title).blocking_pick_folder() {
        Some(path) => path.into_path().map(|p| json!(p.to_string_lossy())).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

// Away after `seconds` without keyboard or mouse (core.ts reportPresence).
pub fn idle_state(seconds: u64) -> Value {
    match user_idle::UserIdle::get_time() {
        Ok(idle) => json!(if idle.as_seconds() >= seconds { "idle" } else { "active" }),
        Err(_) => json!("unknown"),
    }
}

static AWAKE: Mutex<Option<keepawake::KeepAwake>> = Mutex::new(None);

// Held while an agent works (src/main/awake.ts); the display may still sleep.
pub fn keep_awake(on: bool) {
    let mut held = AWAKE.lock().unwrap();
    if on && held.is_none() {
        *held = keepawake::Builder::default().idle(true).reason("An agent is working").app_name("Switchboard").app_reverse_domain(SERVICE).create().ok();
    } else if !on {
        *held = None;
    }
}

// A notification, `id` the host's number for it; `clicked` runs when the person clicks it.
pub fn notify(app: &AppHandle, id: u64, title: &str, body: &str, clicked: impl FnOnce() + Send + 'static) {
    if capturing() {
        eprintln!("capture: notification {title}: {body}");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let (title, body, handle) = (title.to_string(), body.to_string(), app.clone());
        let _ = app.run_on_main_thread(move || mac_notifications::deliver(&handle, id, &title, &body, Box::new(clicked)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        let shown = notify_rust::Notification::new().summary(title).body(body).show();
        if let Ok(handle) = shown {
            std::thread::spawn(move || {
                handle.wait_for_action(|action| {
                    if action != "__closed" {
                        clicked();
                    }
                });
            });
        }
    }
}

// Takes a notification back from the notification centre (its question was answered elsewhere).
// macOS only; elsewhere it stays until the person dismisses it.
pub fn close_notification(app: &AppHandle, id: u64) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || mac_notifications::remove(id));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id);
}

// macOS: NSUserNotificationCenter itself. The app is a bundle, so its notifications go out under
// its own identifier, and the centre's delegate hears the clicks on the main thread. (notify-rust's
// macOS side waited on a thread of its own and gave up at once, so no click came through, and it
// could not take a notification back.)
#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod mac_notifications {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSString, NSUserNotification, NSUserNotificationCenter, NSUserNotificationCenterDelegate};
    use std::collections::HashMap;
    use std::sync::{Mutex, Once, OnceLock};
    use tauri::AppHandle;

    type Click = Box<dyn FnOnce() + Send>;
    static CLICKS: Mutex<Option<HashMap<String, Click>>> = Mutex::new(None);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static DELEGATE: Once = Once::new();

    // Unique to this run: the centre keeps notifications of earlier runs, whose numbers repeat.
    fn key(id: u64) -> String {
        format!("{}-{id}", std::process::id())
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "SwitchboardNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(&self, center: &NSUserNotificationCenter, notification: &NSUserNotification) {
                let click = notification.identifier().and_then(|id| CLICKS.lock().unwrap().as_mut().and_then(|clicks| clicks.remove(&id.to_string())));
                center.removeDeliveredNotification(notification);
                match click {
                    Some(click) => click(),
                    // One an earlier run left: the window, at least.
                    None => {
                        if let Some(app) = APP.get() {
                            crate::show_main(app);
                        }
                    }
                }
            }

            // Shown even while the app is in front, as the Electron app's are.
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(&self, _center: &NSUserNotificationCenter, _notification: &NSUserNotification) -> bool {
                true
            }
        }
    );

    fn center() -> Retained<NSUserNotificationCenter> {
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        DELEGATE.call_once(|| {
            let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
            unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
            // The centre does not keep its delegate: this one lives as long as the app.
            std::mem::forget(delegate);
        });
        center
    }

    pub fn deliver(app: &AppHandle, id: u64, title: &str, body: &str, clicked: Click) {
        let _ = APP.set(app.clone());
        let center = center();
        CLICKS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key(id), clicked);
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        notification.setIdentifier(Some(&NSString::from_str(&key(id))));
        center.deliverNotification(&notification);
    }

    pub fn remove(id: u64) {
        let key = key(id);
        if let Some(clicks) = CLICKS.lock().unwrap().as_mut() {
            clicks.remove(&key);
        }
        let center = center();
        let delivered = center.deliveredNotifications();
        for index in 0..delivered.count() {
            let notification = delivered.objectAtIndex(index);
            if notification.identifier().is_some_and(|identifier| identifier.to_string() == key) {
                center.removeDeliveredNotification(&notification);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key sealed the way Electron's safeStorage seals it opens; another password does not.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn opens_a_key_the_electron_app_sealed() {
        use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let key = "0123456789abcdef".repeat(4);
        for rounds in [1, 1003] {
            let mut derived = [0u8; 16];
            pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"secret", b"saltysalt", rounds, &mut derived);
            let body = cbc::Encryptor::<aes::Aes128>::new(&derived.into(), &[b' '; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(key.as_bytes());
            assert_eq!(open_safe_storage("secret", &body, rounds), Some(key.clone()));
            assert_eq!(open_safe_storage("other", &body, rounds), None);
        }
        // Sealed by Electron 45's safeStorage itself on macOS, with --use-mock-keychain (password "mock_password").
        let electron = "76313009ba585e3735bf093177b9036964f7cfeb005f35741cb3f96c1d3db3540c1cd19675ebd7ede7c46843d02b800e027f5afd6088f735b5c88d7dfe47a93d6ebafc8458245f6d28c61c6d4eda5439b266c6";
        let electron: Vec<u8> = (0..electron.len()).step_by(2).map(|i| u8::from_str_radix(&electron[i..i + 2], 16).unwrap()).collect();
        assert_eq!(open_safe_storage("mock_password", electron.strip_prefix(b"v10").unwrap(), 1003), Some(key));
    }

    #[test]
    fn idle_time_is_readable() {
        assert_ne!(idle_state(300), json!("unknown"));
    }

    // The power assertion is there while held and gone once let go (macOS: pmset lists it).
    #[cfg(target_os = "macos")]
    #[test]
    fn keeping_awake_holds_and_releases_a_power_assertion() {
        let listed = || {
            let out = std::process::Command::new("pmset").args(["-g", "assertions"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains("An agent is working")
        };
        keep_awake(true);
        assert!(listed());
        keep_awake(false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!listed());
    }
}
