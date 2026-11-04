// The in-app browser's page in the Tauri app (docs/tauri-이전.md, step 6): a child webview of the
// main window, kept over the spot the browser screen leaves for it (src/renderer/src/PageView.tsx).
// The screen drives it through these commands (src/renderer/src/tauriSurface.ts), and hears
// about it through "browser:event": navigations and loads from Tauri, and what browser_page.js
// queued in the page (console, failed requests, title, in-page navigation), collected here.
//
// Each system's webview is reached for what Tauri does not offer: scripts in a world of the app's
// own that answer with a value, and snapshots. macOS: WebKit (WKContentWorld, takeSnapshot).
// Linux: WebKitGTK (call_async_javascript_function with a world name, get_snapshot). Windows:
// WebView2's DevTools channel (an isolated world from Page.createIsolatedWorld, Runtime.evaluate,
// Page.captureScreenshot).

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};
use tokio::sync::oneshot;

pub const LABEL: &str = "browser";
const PAGE_SCRIPT: &str = include_str!("browser_page.js");
// The browser's own cookies and storage, apart from the app's page (Electron: persist:claude-ide).
#[cfg(target_os = "macos")]
const STORE: [u8; 16] = *b"switchboard-brwr";

// Only the app's own page drives the browser: a page shown in it reaches no command.
pub fn from_app(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("not allowed".into())
    }
}

fn page(app: &AppHandle) -> Option<Webview> {
    app.get_webview(LABEL)
}

// Called inside WebView2's navigation handlers on Windows: emit_to there kept the page from
// loading, emit does not. The page shown in the browser has no IPC (a remote origin), so it hears
// nothing either way.
fn event(app: &AppHandle, value: Value) {
    if let Some(main) = app.get_webview("main") {
        let _ = main.emit("browser:event", value);
    }
}

// Async: WebView2 deadlocks when a webview is made in a synchronous command (it runs on the main
// thread, where the new webview's setup has to finish).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn browser_place(app: AppHandle, webview: Webview, url: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    from_app(&webview)?;
    if let Some(page) = page(&app) {
        let _ = page.set_position(LogicalPosition::new(x, y));
        let _ = page.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)));
        let _ = if visible { page.show() } else { page.hide() };
        return Ok(());
    }
    let url: Url = url.parse().map_err(|e| format!("{e}"))?;
    let window = app.get_window("main").ok_or("no main window")?;
    let (on_nav, on_load) = (app.clone(), app.clone());
    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(PAGE_SCRIPT)
        // A session may drive the page while the window is in the back (as the main page, tauri.conf.json).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            event(&on_nav, json!({ "kind": "startNavigation", "url": url.as_str() }));
            true
        })
        .on_page_load(move |page, payload| {
            let url = payload.url().as_str().to_string();
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => event(&on_load, json!({ "kind": "startLoading", "url": url })),
                tauri::webview::PageLoadEvent::Finished => {
                    let _ = page;
                    event(&on_load, json!({ "kind": "loaded", "url": url }));
                }
            }
        });
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(STORE);
    }
    let page = window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())?;
    if !visible {
        let _ = page.hide();
    }
    collect(app.clone());
    Ok(())
}

#[tauri::command]
pub fn browser_load(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    from_app(&webview)?;
    let url: Url = url.parse().map_err(|e| format!("{e}"))?;
    page(&app).ok_or("no browser yet")?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, webview: Webview, ignore_cache: bool) -> Result<(), String> {
    from_app(&webview)?;
    let page = page(&app).ok_or("no browser yet")?;
    #[cfg(target_os = "macos")]
    if ignore_cache {
        return page
            .with_webview(|platform| unsafe {
                let _ = mac::web_view(&platform).reloadFromOrigin();
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "linux")]
    if ignore_cache {
        use webkit2gtk::WebViewExt;
        return page.with_webview(|platform| platform.inner().reload_bypass_cache()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "windows")]
    if ignore_cache {
        tauri::async_runtime::spawn(async move {
            let _ = win::cdp(&page, "Page.reload", json!({ "ignoreCache": true })).await;
        });
        return Ok(());
    }
    let _ = ignore_cache;
    page.reload().map_err(|e| e.to_string())
}

// Whether something answers at the page's address: WebKit does not tell a refused connection
// apart, so the screen asks before it loads a page (its error page offers to start the server).
#[tauri::command]
pub async fn browser_probe(webview: Webview, url: String) -> Result<Option<String>, String> {
    from_app(&webview)?;
    let url: Url = url.parse().map_err(|e| format!("{e}"))?;
    let (Some(host), Some(port)) = (url.host_str().map(String::from), url.port_or_known_default()) else {
        return Ok(None);
    };
    let found = tauri::async_runtime::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let addresses: Vec<_> = (host.trim_matches(['[', ']']), port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
        if addresses.is_empty() {
            return Some("ERR_NAME_NOT_RESOLVED".to_string());
        }
        let reached = addresses.iter().any(|address| std::net::TcpStream::connect_timeout(address, Duration::from_millis(1500)).is_ok());
        (!reached).then(|| "ERR_CONNECTION_REFUSED".to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(found)
}

// A script in the app's own world ("switchboard"), answering with its value (a promise is awaited).
#[tauri::command]
pub async fn browser_run(app: AppHandle, webview: Webview, code: String) -> Result<Value, String> {
    from_app(&webview)?;
    let page = page(&app).ok_or("no browser yet")?;
    run_in(&page, code, World::App).await
}

// A PNG data URL of the page, or of a part of it (page coordinates in points).
#[tauri::command]
pub async fn browser_capture(app: AppHandle, webview: Webview, rect: Option<[f64; 4]>) -> Result<Option<String>, String> {
    from_app(&webview)?;
    let page = page(&app).ok_or("no browser yet")?;
    capture(&page, rect).await
}

#[derive(Clone, Copy)]
pub enum World {
    Page,
    App,
}

// What a script's or a snapshot's completion sends back, or the page's silence.
async fn answer<T>(rx: oneshot::Receiver<Result<T, String>>) -> Result<T, String> {
    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result,
        _ => Err("the page did not answer".into()),
    }
}

// The script's value goes through JSON, so the answer is what Electron's executeJavaScript gives.
#[cfg(not(target_os = "windows"))]
const ASYNC_BODY: &str = "const value = await (0, eval)(code); return value === undefined ? null : JSON.stringify(value)";

fn data_url(png: &[u8]) -> String {
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

async fn run_in(page: &Webview, code: String, world: World) -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    return win::run(page, code, world).await;
    #[cfg(not(target_os = "windows"))]
    {
        let (tx, rx) = oneshot::channel();
        page.with_webview(move |platform| unsafe { native::run(&platform, &code, world, tx) }).map_err(|e| e.to_string())?;
        answer(rx).await
    }
}

async fn capture(page: &Webview, rect: Option<[f64; 4]>) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    return win::capture(page, rect).await;
    #[cfg(not(target_os = "windows"))]
    {
        let (tx, rx) = oneshot::channel();
        page.with_webview(move |platform| unsafe { native::snapshot(&platform, rect, tx) }).map_err(|e| e.to_string())?;
        answer(rx).await
    }
}

// What the page queued (browser_page.js) and what the app's scripts said (their console in the
// app's world: the picker's messages, picker.ts), a few times a second while a browser exists.
fn collect(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let Some(page) = page(&app) else { return };
            if let Ok(Value::Array(entries)) = run_in(&page, "window.__sbDrain ? window.__sbDrain() : []".into(), World::Page).await {
                for entry in entries {
                    event(&app, entry);
                }
            }
            if let Ok(Value::Array(lines)) = run_in(&page, "window.__sbOut ? window.__sbOut.splice(0) : []".into(), World::App).await {
                for line in lines {
                    event(&app, json!({ "kind": "console", "level": 1, "message": line, "world": "app" }));
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
use mac as native;

#[cfg(target_os = "macos")]
mod mac {
    use super::{data_url, World, ASYNC_BODY};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKSnapshotConfiguration, WKWebView};
    use serde_json::Value;
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    pub unsafe fn web_view(platform: &tauri::webview::PlatformWebview) -> &WKWebView {
        &*(platform.inner().cast::<WKWebView>())
    }

    // WebKit keeps a named world only while someone holds it: one reference stays for the life of
    // the app, so what the app's scripts set there (the picker's state, its console) lasts.
    static APP_WORLD_HELD: std::sync::Once = std::sync::Once::new();

    fn world(which: World, mtm: MainThreadMarker) -> Retained<WKContentWorld> {
        unsafe {
            match which {
                World::Page => WKContentWorld::pageWorld(mtm),
                World::App => {
                    let world = WKContentWorld::worldWithName(&NSString::from_str("switchboard"), mtm);
                    APP_WORLD_HELD.call_once(|| std::mem::forget(world.clone()));
                    world
                }
            }
        }
    }

    pub unsafe fn run(platform: &tauri::webview::PlatformWebview, code: &str, which: World, tx: oneshot::Sender<Result<Value, String>>) {
        let mtm = MainThreadMarker::new().expect("WebKit on the main thread");
        let body = NSString::from_str(ASYNC_BODY);
        let key = NSString::from_str("code");
        let value: Retained<AnyObject> = NSString::from_str(code).into();
        let arguments = NSDictionary::from_retained_objects(&[&*key], &[value]);
        let sender = Mutex::new(Some(tx));
        let done = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            let answer = if !error.is_null() {
                Err((*error).localizedDescription().to_string())
            } else if result.is_null() {
                Ok(Value::Null)
            } else {
                match (*result).downcast_ref::<NSString>() {
                    Some(text) => Ok(serde_json::from_str(&text.to_string()).unwrap_or(Value::Null)),
                    None => Ok(Value::Null),
                }
            };
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(answer);
            }
        });
        web_view(platform).callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(&body, Some(&arguments), None, &world(which, mtm), Some(&done));
    }

    pub unsafe fn snapshot(platform: &tauri::webview::PlatformWebview, rect: Option<[f64; 4]>, tx: oneshot::Sender<Result<Option<String>, String>>) {
        let mtm = MainThreadMarker::new().expect("WebKit on the main thread");
        let config = WKSnapshotConfiguration::new(mtm);
        if let Some([x, y, width, height]) = rect {
            config.setRect(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)));
        }
        let sender = Mutex::new(Some(tx));
        let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let answer = if !error.is_null() || image.is_null() {
                Ok(None)
            } else {
                png(&*image).map(|bytes| Some(data_url(&bytes))).ok_or_else(|| "the snapshot could not be read".to_string())
            };
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(answer);
            }
        });
        web_view(platform).takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
    }

    unsafe fn png(image: &NSImage) -> Option<Vec<u8>> {
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let data = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
        Some(data.to_vec())
    }
}

#[cfg(target_os = "linux")]
use gtk_view as native;

#[cfg(target_os = "linux")]
mod gtk_view {
    use super::{data_url, World, ASYNC_BODY};
    use gtk::prelude::WidgetExt;
    use javascriptcore::ValueExt;
    use serde_json::Value;
    use tokio::sync::oneshot;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    pub unsafe fn run(platform: &tauri::webview::PlatformWebview, code: &str, which: World, tx: oneshot::Sender<Result<Value, String>>) {
        let arguments = glib::VariantDict::new(None);
        arguments.insert("code", code);
        let world = match which {
            World::Page => None,
            World::App => Some("switchboard"),
        };
        platform.inner().call_async_javascript_function(ASYNC_BODY, Some(&arguments.end()), world, None, None::<&gio::Cancellable>, move |result| {
            let answer = match result {
                Ok(value) if value.is_string() => Ok(serde_json::from_str(&value.to_str()).unwrap_or(Value::Null)),
                Ok(_) => Ok(Value::Null),
                Err(error) => Err(error.message().to_string()),
            };
            let _ = tx.send(answer);
        });
    }

    pub unsafe fn snapshot(platform: &tauri::webview::PlatformWebview, rect: Option<[f64; 4]>, tx: oneshot::Sender<Result<Option<String>, String>>) {
        let view = platform.inner();
        let width = f64::from(view.allocated_width().max(1));
        view.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gio::Cancellable>, move |result| {
            let answer = match result {
                Ok(surface) => png(surface, rect, width).map(|bytes| Some(data_url(&bytes))).ok_or_else(|| "the snapshot could not be read".to_string()),
                Err(error) => {
                    eprintln!("browser snapshot: {error}");
                    Ok(None)
                }
            };
            let _ = tx.send(answer);
        });
    }

    // The snapshot (device pixels), cut to `rect` (page points) when there is one.
    fn png(surface: cairo::Surface, rect: Option<[f64; 4]>, view_width: f64) -> Option<Vec<u8>> {
        let image = cairo::ImageSurface::try_from(surface).ok()?;
        let scale = f64::from(image.width()) / view_width;
        let [x, y, width, height] = rect.unwrap_or([0.0, 0.0, f64::from(image.width()) / scale, f64::from(image.height()) / scale]);
        let out = cairo::ImageSurface::create(cairo::Format::ARgb32, ((width * scale).round() as i32).max(1), ((height * scale).round() as i32).max(1)).ok()?;
        {
            let paint = cairo::Context::new(&out).ok()?;
            paint.set_source_surface(&image, -x * scale, -y * scale).ok()?;
            paint.paint().ok()?;
        }
        let mut bytes = Vec::new();
        out.write_to_png(&mut bytes).ok()?;
        Some(bytes)
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::{answer, data_url, World};
    use serde_json::{json, Value};
    use std::sync::Mutex;
    use tauri::Webview;
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    // The app's world in the page now shown: made once per document, as WebKit keeps its world.
    static APP_CONTEXT: Mutex<Option<i64>> = Mutex::new(None);

    // One method of the page's DevTools protocol, WebView2's own channel to it.
    pub async fn cdp(page: &Webview, method: &'static str, params: Value) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        page.with_webview(move |platform| unsafe {
            let Ok(view) = platform.controller().CoreWebView2() else { return };
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, reply: String| {
                let _ = tx.send(match result {
                    Ok(()) => serde_json::from_str(&reply).map_err(|e| e.to_string()),
                    Err(error) => Err(error.message()),
                });
                Ok(())
            }));
            let _ = view.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.to_string()), &done);
        })
        .map_err(|e| e.to_string())?;
        answer(rx).await
    }

    async fn app_context(page: &Webview) -> Result<i64, String> {
        if let Some(id) = *APP_CONTEXT.lock().unwrap() {
            return Ok(id);
        }
        let tree = cdp(page, "Page.getFrameTree", json!({})).await?;
        let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or("the page has no frame")?.to_string();
        let made = cdp(page, "Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": "switchboard" })).await?;
        let id = made["executionContextId"].as_i64().ok_or("no world for the app")?;
        *APP_CONTEXT.lock().unwrap() = Some(id);
        Ok(id)
    }

    async fn evaluate(page: &Webview, code: &str, context: Option<i64>) -> Result<Value, String> {
        let expression = format!("(async () => {{ const value = await (0, eval)({}); return value === undefined ? null : JSON.stringify(value) }})()", serde_json::to_string(code).unwrap_or_default());
        let mut params = json!({ "expression": expression, "awaitPromise": true, "returnByValue": true });
        if let Some(id) = context {
            params["contextId"] = json!(id);
        }
        let reply = cdp(page, "Runtime.evaluate", params).await?;
        if let Some(details) = reply.get("exceptionDetails") {
            return Err(details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("the script failed").to_string());
        }
        Ok(reply["result"]["value"].as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or(Value::Null))
    }

    pub async fn run(page: &Webview, code: String, world: World) -> Result<Value, String> {
        match world {
            World::Page => evaluate(page, &code, None).await,
            World::App => {
                let id = app_context(page).await?;
                match evaluate(page, &code, Some(id)).await {
                    // A new document: its world is made again.
                    Err(error) if error.contains("context") => {
                        *APP_CONTEXT.lock().unwrap() = None;
                        let id = app_context(page).await?;
                        evaluate(page, &code, Some(id)).await
                    }
                    other => other,
                }
            }
        }
    }

    pub async fn capture(page: &Webview, rect: Option<[f64; 4]>) -> Result<Option<String>, String> {
        let mut params = json!({ "format": "png" });
        if let Some([x, y, width, height]) = rect {
            params["clip"] = json!({ "x": x, "y": y, "width": width, "height": height, "scale": 1 });
        }
        let reply = cdp(page, "Page.captureScreenshot", params).await?;
        let Some(data) = reply["data"].as_str() else { return Ok(None) };
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.decode(data).ok().map(|png| data_url(&png)))
    }
}
