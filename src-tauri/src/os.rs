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
    let entry = match keyring::Entry::new(SERVICE, "app-key") {
        Ok(entry) => entry,
        Err(_) => return fresh(),
    };
    match entry.get_password() {
        Ok(key) if valid_key(&key) => json!({ "key": key, "refused": false, "lasting": true }),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let key = electron_key(data).unwrap_or_else(random_key);
            let lasting = entry.set_password(&key).is_ok();
            json!({ "key": key, "refused": false, "lasting": lasting })
        }
        Err(keyring::Error::NoStorageAccess(_)) => json!({ "key": random_key(), "refused": true, "lasting": false }),
        Err(_) => fresh(),
    }
}

// The key the Electron app kept (docs/tauri-이전.md, step 7): app-key.bin in the same data folder,
// sealed by Electron's safeStorage. Taking it over keeps the bridge and the terminal host that app
// left running, with their sessions and terminals; without it the app starts a bridge of its own.
// On macOS the seal is Chromium's: "v10", then AES-128-CBC under a key derived from the password
// of the keychain item "claude-ide Safe Storage" (the keychain asks the person once).
#[cfg(target_os = "macos")]
fn electron_key(data: &std::path::Path) -> Option<String> {
    let sealed = std::fs::read(data.join("app-key.bin")).ok()?;
    let password = keyring::Entry::new("claude-ide Safe Storage", "claude-ide Key").ok()?.get_password().ok()?;
    let key = open_safe_storage(&password, &sealed)?;
    valid_key(&key).then_some(key)
}

#[cfg(not(target_os = "macos"))]
fn electron_key(_data: &std::path::Path) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn open_safe_storage(password: &str, sealed: &[u8]) -> Option<String> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = sealed.strip_prefix(b"v10")?;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
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

// A notification; `clicked` runs when the person clicks it (waits on a thread of its own).
pub fn notify(title: &str, body: &str, clicked: impl FnOnce() + Send + 'static) {
    if capturing() {
        eprintln!("capture: notification {title}: {body}");
        return;
    }
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

#[cfg(target_os = "macos")]
pub fn prepare_notifications() {
    let _ = notify_rust::set_application(SERVICE);
}

#[cfg(not(target_os = "macos"))]
pub fn prepare_notifications() {}

#[cfg(test)]
mod tests {
    use super::*;

    // A key sealed the way Electron's safeStorage seals it on macOS opens; another password does not.
    #[cfg(target_os = "macos")]
    #[test]
    fn opens_a_key_the_electron_app_sealed() {
        use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let key = "0123456789abcdef".repeat(4);
        let mut derived = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"secret", b"saltysalt", 1003, &mut derived);
        let body = cbc::Encryptor::<aes::Aes128>::new(&derived.into(), &[b' '; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(key.as_bytes());
        let sealed = [b"v10".as_slice(), &body].concat();
        assert_eq!(open_safe_storage("secret", &sealed), Some(key.clone()));
        assert_eq!(open_safe_storage("other", &sealed), None);
        assert_eq!(open_safe_storage("secret", &body), None);
        // Sealed by Electron 45's safeStorage itself, with --use-mock-keychain (password "mock_password").
        let electron = "76313009ba585e3735bf093177b9036964f7cfeb005f35741cb3f96c1d3db3540c1cd19675ebd7ede7c46843d02b800e027f5afd6088f735b5c88d7dfe47a93d6ebafc8458245f6d28c61c6d4eda5439b266c6";
        let electron: Vec<u8> = (0..electron.len()).step_by(2).map(|i| u8::from_str_radix(&electron[i..i + 2], 16).unwrap()).collect();
        assert_eq!(open_safe_storage("mock_password", &electron), Some(key));
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
