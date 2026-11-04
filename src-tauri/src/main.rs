// No console window beside the app on Windows (a debug build keeps one, for its output).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Switchboard's Tauri shell (docs/tauri-이전.md). Thin on purpose: the app logic runs in the Node
// host (src/host/main.ts, the same core the Electron shell runs), and this shell relays.
// - The page's calls (window.ide, by the channels of src/shared/ideCalls.ts) go to the host as
//   invoke/send; its answers come back as the command's result.
// - The host's events for the page (emit) become Tauri events of the same channel name.
// - The host asks for what only the shell can do (os): the window, opening files and links,
//   the Dock badge, notifications, dialogs, power. One JSON message per line on its stdin/stdout.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, EventTarget, Manager, RunEvent, State, WindowEvent};

mod browser;
mod os;

// The host's id of a page call, and the page's own id for it (its answer goes back under that).
type Pending = Arc<Mutex<HashMap<u64, String>>>;

struct Host {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    next: AtomicU64,
    quitting: Mutex<bool>,
    // True once the host has started the app (its ready message). The Electron app opens its window
    // only then; here the page loads at once, and its calls wait for it, so the first state it reads
    // is the bridge's and not an empty one.
    ready: tokio::sync::watch::Sender<bool>,
}

impl Host {
    fn write(&self, message: &Value) {
        let mut stdin = self.stdin.lock().unwrap();
        let _ = writeln!(stdin, "{message}");
        let _ = stdin.flush();
    }
}

// Everything the host tells the page, on one event of the main page: its events ({channel,
// payload}) and the answers to its calls ({reply, value | error}), in the order the host wrote them.
// A command's return and an event take different ways to the page, so an answer returned by the
// command could arrive after a change the host sent later, and the page would keep the older state
// (connected() answering false after onConnection heard true).
fn to_page(app: &AppHandle, message: Value) {
    let _ = app.emit_to(EventTarget::webview("main"), "ide:event", message);
}

// A page call with an answer: sent to the host once it is up; the answer comes as an ide:event
// under the page's id for the call (`call`).
#[tauri::command]
async fn ide_invoke(webview: tauri::Webview, host: State<'_, Arc<Host>>, call: String, channel: String, args: Vec<Value>) -> Result<(), String> {
    browser::from_app(&webview)?;
    let mut ready = host.ready.subscribe();
    ready.wait_for(|ready| *ready).await.map_err(|_| "the app's Node host has stopped".to_string())?;
    let id = host.next.fetch_add(1, Ordering::SeqCst);
    host.pending.lock().unwrap().insert(id, call);
    host.write(&json!({ "t": "invoke", "id": id, "channel": channel, "args": args }));
    Ok(())
}

// A page call without an answer (terminal input, resizes).
#[tauri::command]
fn ide_send(webview: tauri::Webview, host: State<'_, Arc<Host>>, channel: String, args: Vec<Value>) {
    if browser::from_app(&webview).is_err() {
        return;
    }
    host.write(&json!({ "t": "send", "channel": channel, "args": args }));
}

// Checks without a person at the screen (CLAUDE_IDE_CAPTURE_JS): what the script reports.
#[tauri::command]
fn capture_log(webview: tauri::Webview, text: String) {
    if browser::from_app(&webview).is_err() {
        return;
    }
    eprintln!("capture: {text}");
}

// A file, folder or link in the program the system opens it with (ShellExecute on Windows, so no
// shell reads the text; xdg-open and its kin on Linux).
fn open_with_system(target: &str) -> String {
    match open::that(target) {
        Ok(()) => String::new(),
        Err(error) => format!("could not open {target}: {error}"),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// What the host asks of the shell. Requests with an id get a reply. What may wait on the person
// (a dialog) answers from a thread of its own, so the host's other messages keep flowing.
fn on_os(app: &AppHandle, host: &Arc<Host>, message: &Value) {
    let op = message["op"].as_str().unwrap_or("");
    let reply = |host: &Host, value: Value| {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            host.write(&json!({ "t": "reply", "id": id, "value": value }));
        }
    };
    if op == "messageBox" || op == "pickFolder" {
        let (app, host, message) = (app.clone(), host.clone(), message.clone());
        thread::spawn(move || {
            let value = if message["op"] == "messageBox" { os::message_box(&app, &message["box"]) } else { os::pick_folder(&app, message["title"].as_str().unwrap_or("")) };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                host.write(&json!({ "t": "reply", "id": id, "value": value }));
            }
        });
        return;
    }
    let value = match op {
        "focusWindow" => {
            show_main(app);
            Value::Null
        }
        "quit" => {
            app.exit(0);
            Value::Null
        }
        "openPath" => json!(open_with_system(message["path"].as_str().unwrap_or(""))),
        "openExternal" => {
            let url = message["url"].as_str().unwrap_or("");
            if url.starts_with("https://") || url.starts_with("http://") {
                open_with_system(url);
            }
            Value::Null
        }
        // The Dock's badge; the Electron app shows none on Windows and Linux either.
        "setBadge" => {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let text = message["text"].as_str().unwrap_or("");
                let _ = window.set_badge_label(if text.is_empty() { None } else { Some(text.to_string()) });
            }
            Value::Null
        }
        "idleState" => os::idle_state(message["seconds"].as_u64().unwrap_or(300)),
        "keepAwake" => {
            os::keep_awake(message["on"].as_bool() == Some(true));
            Value::Null
        }
        "notify" => {
            let (handle, host, id) = (app.clone(), host.clone(), message["notification"].clone());
            os::notify(message["title"].as_str().unwrap_or("Switchboard"), message["body"].as_str().unwrap_or(""), move || {
                show_main(&handle);
                host.write(&json!({ "t": "event", "name": "notificationClick", "notification": id }));
            });
            Value::Null
        }
        other => {
            eprintln!("host asked for an unknown os op: {other}");
            Value::Null
        }
    };
    reply(host, value);
}

// Where the Node side comes from. Installed: Node beside the app's executable (externalBin)
// and Resources/node (scripts/stage-tauri.ts). From the repo (SWITCHBOARD_REPO, or a build with
// nothing staged): the system's node and the repo's own files.
struct Layout {
    node: std::path::PathBuf,
    host: std::path::PathBuf,
    root: std::path::PathBuf,
    packaged: bool,
}

fn layout(app: &AppHandle) -> Layout {
    let repo = |path: std::path::PathBuf| Layout { node: "node".into(), host: path.join("out/host/main.mjs"), root: path, packaged: false };
    if let Ok(path) = std::env::var("SWITCHBOARD_REPO") {
        return repo(path.into());
    }
    // Windows gives the resource folder as a verbatim path (\\?\C:\...), which Node cannot start a
    // script from (it reads "C:" as a file): the plain form of the same path.
    let resources = app.path().resource_dir().ok().map(|dir| dunce::simplified(&dir).to_path_buf());
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(if cfg!(windows) { "switchboard-node.exe" } else { "switchboard-node" })));
    match (resources, beside) {
        (Some(resources), Some(node)) if node.exists() && resources.join("node/host/main.mjs").exists() => {
            Layout { node, host: resources.join("node/host/main.mjs"), root: resources, packaged: true }
        }
        _ => repo(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()),
    }
}

fn start_host(app: &AppHandle) -> Arc<Host> {
    let place = layout(app);
    // The Electron app's data folder (its userData, named after package.json): the two share the
    // settings, the update folder and the key the Electron app kept (os::app_key).
    let data = app.path().config_dir().map(|dir| dunce::simplified(&dir).join("claude-ide")).unwrap_or_else(|_| place.root.join(".tauri-data"));
    let _ = std::fs::create_dir_all(&data);
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".into());
    let info = json!({
        "version": app.package_info().version.to_string(),
        "locale": locale,
        "packaged": place.packaged,
        "appPath": place.root,
        "resourcesPath": place.root,
        "userDataPath": data,
        "appKey": os::app_key(&data),
        // For an update's swap (src/main/macUpdate.ts): the bundle to replace and the process to wait for.
        "exePath": std::env::current_exe().map(|exe| exe.to_string_lossy().into_owned()).unwrap_or_default(),
        "appPid": std::process::id(),
        "machineArch": machine_arch(),
    });
    let mut command = Command::new(&place.node);
    // Windows gives a console program started from a windowed one a console window of its own.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command
        .arg(&place.host)
        .current_dir(&place.root)
        .env("SWITCHBOARD_HOST", info.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("could not start the app's Node host");
    let stdout = child.stdout.take().unwrap();
    let host = Arc::new(Host {
        stdin: Mutex::new(child.stdin.take().unwrap()),
        child: Mutex::new(child),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next: AtomicU64::new(1),
        quitting: Mutex::new(false),
        ready: tokio::sync::watch::Sender::new(false),
    });
    let reader_host = host.clone();
    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("host: {line}");
                continue;
            };
            match message["t"].as_str() {
                Some("result") => {
                    let id = message["id"].as_u64().unwrap_or(0);
                    if let Some(call) = reader_host.pending.lock().unwrap().remove(&id) {
                        to_page(&handle, json!({ "reply": call, "value": message["value"], "error": message["error"] }));
                    }
                }
                Some("emit") => to_page(&handle, json!({ "channel": message["channel"], "payload": message["payload"] })),
                Some("os") => on_os(&handle, &reader_host, &message),
                Some("ready") => {
                    eprintln!("host: ready");
                    reader_host.ready.send_replace(true);
                }
                _ => {}
            }
        }
        // The host ended: calls still waiting get an error, and the app goes too.
        for (_, call) in reader_host.pending.lock().unwrap().drain() {
            to_page(&handle, json!({ "reply": call, "error": "the app's Node host has stopped" }));
        }
        if !*reader_host.quitting.lock().unwrap() {
            eprintln!("the app's Node host ended; quitting");
            handle.exit(1);
        }
    });
    host
}

// The machine's architecture in Node's words. An x64 build that ARM64 Windows runs emulated says
// arm64, so its next update is the ARM64 build (src/main/updateFlow.ts AppPlace).
fn machine_arch() -> &'static str {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE;
        use windows::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
        let (mut process, mut native) = (IMAGE_FILE_MACHINE(0), IMAGE_FILE_MACHINE(0));
        // IMAGE_FILE_MACHINE_ARM64
        if IsWow64Process2(GetCurrentProcess(), &mut process, Some(&mut native)).is_ok() && native.0 == 0xAA64 {
            return "arm64";
        }
    }
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

// The quit waits for the host's own (terminals, dev servers) for up to ten seconds.
fn stop_host(host: &Host) {
    {
        let mut quitting = host.quitting.lock().unwrap();
        if *quitting {
            return;
        }
        *quitting = true;
    }
    host.write(&json!({ "t": "quit" }));
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(Some(_)) = host.child.lock().unwrap().try_wait() {
            return;
        }
        if Instant::now() > until {
            let _ = host.child.lock().unwrap().kill();
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

// macOS puts an app whose window is hidden to sleep (App Nap): its page's timers then all but stop,
// and the page has work of its own while the window is closed (an answer's five seconds to take
// it back, the session list kept current for the Dock badge). Held for the life of the app, as the
// Electron app's page keeps running; the computer may still go to sleep when idle.
#[cfg(target_os = "macos")]
fn stay_awake_while_hidden() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let reason = NSString::from_str("Switchboard follows its sessions while its window is hidden");
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason);
    std::mem::forget(activity);
}

fn main() {
    // The Electron app's updater puts an AppImage in place, then runs it with this set and waits for
    // it to end, for the set-up electron-builder's AppImages do then. This one has none to do: it
    // starts the next time the person opens it.
    #[cfg(target_os = "linux")]
    if std::env::var("APPIMAGE_EXIT_AFTER_INSTALL").as_deref() == Ok("true") {
        return;
    }
    os::prepare_notifications();
    #[cfg(target_os = "macos")]
    stay_awake_while_hidden();
    let app = tauri::Builder::default()
        // A second start brings the running window forward and ends (first, before the rest).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ide_invoke,
            ide_send,
            capture_log,
            browser::browser_place,
            browser::browser_load,
            browser::browser_reload,
            browser::browser_probe,
            browser::browser_run,
            browser::browser_capture
        ])
        .setup(|app| {
            let host = start_host(app.handle());
            app.manage(host);
            // Checks without a person at the screen: no Dock icon, no focus, the window never shown,
            // and a script run in the page once it has loaded.
            let capture = std::env::var("CLAUDE_IDE_CAPTURE_JS").ok();
            // (The script itself runs in on_page_load below.)
            #[cfg(target_os = "macos")]
            if capture.is_some() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            // CLAUDE_IDE_CAPTURE_SHOW: shown all the same, for a check on a virtual display (Xvfb),
            // where WebKitGTK draws, and so snapshots, only a window that is on screen.
            if capture.is_none() || std::env::var("CLAUDE_IDE_CAPTURE_SHOW").is_ok() {
                show_main(app.handle());
            }
            Ok(())
        })
        // The capture script runs once the page has loaded (every load is logged, so a reload shows).
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if let Ok(script) = std::env::var("CLAUDE_IDE_CAPTURE_JS") {
                eprintln!("capture: page loaded {}", payload.url());
                let _ = webview.eval(
                    "window.addEventListener('error', e => window.__TAURI_INTERNALS__.invoke('capture_log', { text: 'page error: ' + e.message }))",
                );
                let _ = webview.eval(&script);
            }
        })
        .on_window_event(|window, event| {
            // On macOS closing the window keeps the app (and its notifications) running, as the
            // Electron app does; the Dock icon brings it back (RunEvent::Reopen below).
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            if let WindowEvent::Focused(focused) = event {
                if let Some(host) = window.app_handle().try_state::<Arc<Host>>() {
                    host.write(&json!({ "t": "event", "name": "focus", "focused": focused }));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|handle, event| match event {
        RunEvent::Exit => {
            if let Some(host) = handle.try_state::<Arc<Host>>() {
                stop_host(&host);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        _ => {}
    });
}
