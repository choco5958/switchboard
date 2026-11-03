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
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::sync::oneshot;

mod browser;
mod os;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Host {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    next: AtomicU64,
    quitting: Mutex<bool>,
}

impl Host {
    fn write(&self, message: &Value) {
        let mut stdin = self.stdin.lock().unwrap();
        let _ = writeln!(stdin, "{message}");
        let _ = stdin.flush();
    }
}

// A page call with an answer: the host's result, or its error as a rejected promise.
#[tauri::command]
async fn ide_invoke(webview: tauri::Webview, host: State<'_, Arc<Host>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    browser::from_app(&webview)?;
    let id = host.next.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    host.pending.lock().unwrap().insert(id, tx);
    host.write(&json!({ "t": "invoke", "id": id, "channel": channel, "args": args }));
    let reply = rx.await.map_err(|_| "the app's Node host has stopped".to_string())?;
    match reply.get("error") {
        Some(error) if !error.is_null() => Err(error.as_str().unwrap_or("failed").to_string()),
        _ => Ok(reply.get("value").cloned().unwrap_or(Value::Null)),
    }
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

fn open_with_system(target: &str) -> String {
    #[cfg(target_os = "macos")]
    let opened = Command::new("open").arg(target).status();
    #[cfg(target_os = "windows")]
    let opened = Command::new("cmd").args(["/C", "start", "", target]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = Command::new("xdg-open").arg(target).status();
    match opened {
        Ok(status) if status.success() => String::new(),
        Ok(status) => format!("could not open {target}: {status}"),
        Err(error) => error.to_string(),
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
        "setBadge" => {
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
    let resources = app.path().resource_dir().ok();
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
    let data = app.path().app_data_dir().unwrap_or_else(|_| place.root.join(".tauri-data"));
    let _ = std::fs::create_dir_all(&data);
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".into());
    let info = json!({
        "version": app.package_info().version.to_string(),
        "locale": locale,
        "packaged": place.packaged,
        "appPath": place.root,
        "resourcesPath": place.root,
        "userDataPath": data,
        "appKey": os::app_key(),
    });
    let mut child = Command::new(&place.node)
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
                    if let Some(tx) = reader_host.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(message);
                    }
                }
                Some("emit") => {
                    let _ = handle.emit(message["channel"].as_str().unwrap_or(""), message["payload"].clone());
                }
                Some("os") => on_os(&handle, &reader_host, &message),
                Some("ready") => eprintln!("host: ready"),
                _ => {}
            }
        }
        // The host ended: calls still waiting get an error, and the app goes too.
        reader_host.pending.lock().unwrap().clear();
        if !*reader_host.quitting.lock().unwrap() {
            eprintln!("the app's Node host ended; quitting");
            handle.exit(1);
        }
    });
    host
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

fn main() {
    os::prepare_notifications();
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
            if capture.is_none() {
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
