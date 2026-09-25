mod ai;
mod analytics;
mod cli;
#[cfg(target_os = "macos")]
mod default_app;
mod error;
mod feedback;
mod files;
mod migrate;
#[cfg(target_os = "macos")]
mod open_panel;
mod tools;
mod updater;

use ai::tokio_util_lite::CancelToken;
use ai::{AiRequest, PingResult, StreamEvent};
use error::{AppError, Result};
use files::{RawPage, ResolvedSession, VersionInfo};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Streams(Mutex<HashMap<String, CancelToken>>);

/// Files macOS asked the app to open (a double-click in Finder, Open With, a drop on the Dock
/// icon). On a cold launch that arrives before any window exists, so the paths wait here until
/// the reader asks for them; after that they go straight to the main window.
#[derive(Default)]
struct Opened {
    paths: Mutex<Vec<String>>,
    ready: AtomicBool,
}

// ---------- files ----------

/// Folder only: Settings uses it for the default folder.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p.map(|p| p.to_string()));
    });
    Ok(rx.await.map_err(|_| AppError::Message("dialog closed".into()))?)
}

/// A yes/no the reader has to answer before something costly happens, asked the way the Open panel
/// asks: a native sheet, so it needs nothing of the reader UI and follows straight on from one.
#[tauri::command]
async fn confirm(app: AppHandle, message: String, detail: Option<String>, ok_label: Option<String>) -> Result<bool> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().message(detail.unwrap_or_default()).title(message);
    dialog = dialog.buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
        ok_label.unwrap_or_else(|| "OK".into()),
        "Cancel".into(),
    ));
    dialog.show(move |ok| {
        let _ = tx.send(ok);
    });
    Ok(rx.await.map_err(|_| AppError::Message("dialog closed".into()))?)
}

/// ⌘O and ⌘⇧O: one Open panel for folders or Markdown files, worded for starting a session
/// (`purpose` "open", single selection) or for adding to the open one ("add", multiple allowed).
#[tauri::command]
async fn pick_path(app: AppHandle, purpose: Option<String>) -> Result<Vec<String>> {
    let add = purpose.as_deref() == Some("add");
    let message = if add {
        "Add folders of Markdown notes, or .md files, to this session."
    } else {
        "Open a folder of Markdown notes, or a single .md file."
    };
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(open_panel::folder_or_markdown(message, add));
        })
        .map_err(|e| AppError::Message(e.to_string()))?;
        Ok(rx.await.map_err(|_| AppError::Message("dialog closed".into()))?)
    }
    // Other platforms have no panel that takes both, so they get the (single-selection) folder picker.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = message;
        Ok(pick_folder(app).await?.into_iter().collect())
    }
}

#[tauri::command]
fn path_kind(path: String) -> &'static str {
    files::path_kind(&path)
}

#[tauri::command]
fn reveal_in_finder(app: AppHandle, path: String) -> Result<()> {
    app.opener().reveal_item_in_dir(&path).map_err(|e| AppError::Message(e.to_string()))
}

/// The reader calls this once it listens for "opened"; it drains what arrived before then.
#[tauri::command]
fn opened_paths(opened: State<'_, Opened>) -> Vec<String> {
    opened.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *opened.paths.lock().unwrap())
}

#[cfg(target_os = "macos")]
fn open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let opened = app.state::<Opened>();
    let main = app.get_webview_window("main");
    if !opened.ready.load(Ordering::SeqCst) || main.is_none() {
        opened.paths.lock().unwrap().extend(paths);
        return;
    }
    if let Some(w) = main {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", "opened", paths);
}

// ---------- default app for Markdown ----------

/// Which app opens .md files today, and whether it is this one.
#[tauri::command]
async fn default_markdown_app(app: AppHandle) -> Result<Value> {
    #[cfg(target_os = "macos")]
    {
        let identifier = app.config().identifier.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(default_app::current(&identifier));
        })
        .map_err(|e| AppError::Message(e.to_string()))?;
        let state = rx.await.map_err(|_| AppError::Message("no answer from macOS".into()))?;
        Ok(serde_json::to_value(state)?)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "isNested": false, "available": false }))
    }
}

/// Asks macOS to make this app the default for Markdown, then reports what it is now. On
/// macOS 26.4 and later the system asks the user first, so this waits for their answer.
#[tauri::command]
async fn set_default_markdown_app(app: AppHandle) -> Result<Value> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || default_app::request(tx)).map_err(|e| AppError::Message(e.to_string()))?;
        if let Some(message) = rx.await.map_err(|_| AppError::Message("no answer from macOS".into()))? {
            return Err(AppError::Message(message));
        }
    }
    default_markdown_app(app).await
}

#[tauri::command]
fn list_pages(folder: String) -> Result<Vec<RawPage>> {
    files::list_pages(&folder)
}

#[tauri::command]
fn read_page(folder: String, path: String) -> Result<RawPage> {
    files::read_page(&folder, &path)
}

#[tauri::command]
fn write_page(folder: String, path: String, content: String) -> Result<()> {
    files::write_page(&folder, &path, &content)
}

#[tauri::command]
fn delete_page(folder: String, path: String) -> Result<()> {
    files::delete_page(&folder, &path)
}

#[tauri::command]
fn load_map(folder: String) -> Result<Option<Value>> {
    files::load_map(&folder)
}

#[tauri::command]
fn save_map(folder: String, cache: Value, rendered: String) -> Result<()> {
    files::save_map(&folder, &cache, &rendered)
}

#[tauri::command]
fn load_session(folder: String, file: Option<String>) -> Result<Option<Value>> {
    files::load_session(&folder, file.as_deref())
}

#[tauri::command]
fn save_session(folder: String, session: Value, file: Option<String>) -> Result<()> {
    files::save_session(&folder, &session, file.as_deref())
}

#[tauri::command]
fn resolve_session(
    folder: String,
    file: Option<String>,
    ids: Option<HashMap<String, String>>,
    bookmark: Option<String>,
) -> Result<ResolvedSession> {
    files::resolve_session(&folder, file.as_deref(), ids.as_ref(), bookmark.as_deref())
}

#[tauri::command]
fn list_versions(folder: String, path: String) -> Result<Vec<VersionInfo>> {
    files::list_versions(&folder, &path)
}

#[tauri::command]
fn read_version(folder: String, path: String, n: u32) -> Result<String> {
    files::read_version(&folder, &path, n)
}

#[tauri::command]
fn snapshot_version(folder: String, path: String) -> Result<u32> {
    files::snapshot_version(&folder, &path)
}

#[tauri::command]
fn restore_version(folder: String, path: String, n: u32) -> Result<()> {
    files::restore_version(&folder, &path, n)
}

#[tauri::command]
fn delete_version(folder: String, path: String, n: u32) -> Result<()> {
    files::delete_version(&folder, &path, n)
}

// ---------- settings & keys ----------

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = app.path().app_config_dir()?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Option<Value>> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&std::fs::read_to_string(path)?)?))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> Result<()> {
    let path = settings_path(&app)?;
    files::write_atomic(&path, &serde_json::to_string_pretty(&settings)?)?;
    app.emit("settings-changed", &settings)?;
    Ok(())
}

// ---------- recent sessions ----------

fn recents_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join("recents.json"))
}

#[tauri::command]
fn get_recents(app: AppHandle) -> Result<Option<Value>> {
    let path = recents_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&std::fs::read_to_string(path)?)?))
}

#[tauri::command]
fn save_recents(app: AppHandle, recents: Value) -> Result<()> {
    files::write_atomic(&recents_path(&app)?, &serde_json::to_string_pretty(&recents)?)
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<()> {
    let entry = keyring::Entry::new(ai::KEYCHAIN_SERVICE, &provider)?;
    if key.trim().is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        entry.set_password(key.trim())?;
        Ok(())
    }
}

#[tauri::command]
fn has_api_key(provider: String) -> Result<bool> {
    Ok(ai::api_key(&provider).is_ok())
}

// ---------- feedback ----------

/// The Send feedback box: posts the note to the relay, which files a GitHub issue.
#[tauri::command]
async fn send_feedback(app: AppHandle, message: String, email: Option<String>, attachment: Option<feedback::Attachment>) -> Result<()> {
    let url = feedback::relay_url(feedback::RELAY_URL)?;
    let payload = feedback::payload(&message, email.as_deref(), attachment, &app.package_info().version.to_string())?;
    let result = feedback::send(url, &payload).await;
    if result.is_ok() {
        analytics::track_feedback_sent(&app, email.is_some());
    }
    result
}

/// A screenshot dropped on the window while the feedback box is open, reported by path since the
/// window's native drag-drop hands over a path rather than a browser `File`.
#[tauri::command]
fn read_dropped_image(path: String) -> Result<feedback::Attachment> {
    feedback::read_attachment(&path)
}

// ---------- updates ----------

/// Asks the relay whether a newer release exists. Quiet under `tauri dev`, which cannot update itself.
#[tauri::command]
async fn check_for_update(app: AppHandle, pending: State<'_, updater::Pending>) -> Result<updater::UpdateCheck> {
    updater::check(&app, &pending).await
}

/// Downloads and installs the update the last check found; progress goes down the channel.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, updater::Pending>, channel: Channel<updater::UpdateProgress>) -> Result<()> {
    updater::install(&pending, channel, &app).await
}

/// Starts the app again, after an update has been installed.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart()
}

// ---------- AI ----------

#[tauri::command]
async fn ai_stream(app: AppHandle, id: String, req: AiRequest, channel: Channel<StreamEvent>, streams: State<'_, Streams>) -> Result<()> {
    let token = CancelToken::default();
    streams.0.lock().unwrap().insert(id.clone(), token.clone());
    if let Some(kind) = &req.kind {
        analytics::track_ai_ask(&app, kind);
    }
    let result = ai::stream(req, channel, token).await;
    streams.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn ai_cancel(id: String, streams: State<'_, Streams>) {
    if let Some(t) = streams.0.lock().unwrap().remove(&id) {
        t.cancel();
    }
}

#[tauri::command]
async fn ai_ping(provider: String, auth: Option<String>, base_url: String, model: String) -> Result<PingResult> {
    Ok(ai::ping(&provider, auth.as_deref(), &base_url, &model).await)
}

// ---------- windows ----------

fn show_settings(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?window=settings".into()))
        .title("Settings")
        .inner_size(540.0, 600.0)
        .resizable(false)
        .minimizable(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(16.0, 16.0)));
    builder.build()?;
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<()> {
    show_settings(&app)
}

#[tauri::command]
fn open_page_window(app: AppHandle, folder: String, path: String, version: Option<u32>) -> Result<()> {
    let label = format!("page-{}", app.webview_windows().len());
    let mut url = format!("index.html?page={}", urlencode(&path));
    if let Some(n) = version {
        url.push_str(&format!("&version={}", n));
    }
    let _ = folder;
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title("Nested")
        .inner_size(900.0, 680.0)
        .min_inner_size(640.0, 420.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(12.0, 16.0)));
    builder.build()?;
    Ok(())
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, Some("About Nested"), Some(AboutMetadata::default()))?;
    let check_update = MenuItemBuilder::with_id("check-update", "Check for Updates…").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Nested")
        .item(&about)
        .item(&check_update)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // ⌘N stays in the webview, like ⌘R, so it also works while the ask box has focus.
    let new_page = MenuItemBuilder::with_id("new-page", "New Page… (⌘N)").build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?;
    let add_root = MenuItemBuilder::with_id("add-root", "Add to Session…").accelerator("CmdOrCtrl+Shift+O").build(app)?;
    let close_pane = MenuItemBuilder::with_id("close-pane", "Close Pane").accelerator("CmdOrCtrl+W").build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_page)
        .separator()
        .item(&open)
        .item(&add_root)
        .separator()
        .item(&close_pane)
        .build()?;

    // Find and refine keep their shortcuts in the webview (see App.tsx) so they work while typing in a box.
    let refine = MenuItemBuilder::with_id("refine", "Refine (⌘R)").build(app)?;
    let find = MenuItemBuilder::with_id("find", "Find… (⌘F)").build(app)?;
    let find_next = MenuItemBuilder::with_id("find-next", "Find Next (⌘G)").build(app)?;
    let find_prev = MenuItemBuilder::with_id("find-prev", "Find Previous (⌘⇧G)").build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .item(&find_next)
        .item(&find_prev)
        .separator()
        .item(&refine)
        .build()?;

    let sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Tree").accelerator("CmdOrCtrl+B").build(app)?;
    let filter = MenuItemBuilder::with_id("filter", "Filter Files (⌘/)").build(app)?;
    let map = MenuItemBuilder::with_id("map", "Session Map").accelerator("CmdOrCtrl+K").build(app)?;
    let fullscreen = MenuItemBuilder::with_id("fullscreen-pane", "Fullscreen Pane").accelerator("CmdOrCtrl+Shift+F").build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&sidebar)
        .item(&filter)
        .item(&map)
        .item(&fullscreen)
        .separator()
        .fullscreen()
        .build()?;

    let home = MenuItemBuilder::with_id("home", "Home").accelerator("CmdOrCtrl+Shift+H").build(app)?;
    let back = MenuItemBuilder::with_id("back", "Back").accelerator("CmdOrCtrl+[").build(app)?;
    let forward = MenuItemBuilder::with_id("forward", "Forward").accelerator("CmdOrCtrl+]").build(app)?;
    let go_menu = SubmenuBuilder::new(app, "Go").item(&home).separator().item(&back).item(&forward).build()?;

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().separator().close_window().build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &go_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    
    // Register Aptabase plugin only when the app key is set at compile time.
    #[cfg(feature = "aptabase")]
    if let Some(key) = analytics::APP_KEY {
        if !key.trim().is_empty() {
            builder = builder.plugin(freshjuice_tauri_aptabase::Builder::new(key).build());
        }
    }
    
    builder
        .manage(Streams::default())
        .manage(Opened::default())
        .manage(updater::Pending::default())
        .setup(|app| {
            migrate::run(app.handle());
            build_menu(app.handle())?;
            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                if id == "settings" {
                    let _ = show_settings(app);
                    return;
                }
                // ⌘W with Settings in front closes that window rather than a pane in the reader.
                if id == "close-pane" {
                    if let Some(w) = app.get_webview_window("settings") {
                        if w.is_focused().unwrap_or(false) {
                            let _ = w.close();
                            return;
                        }
                    }
                }
                // Send the command to the focused reader window, or the main one.
                let target = app
                    .webview_windows()
                    .into_iter()
                    .find(|(label, w)| label != "settings" && w.is_focused().unwrap_or(false))
                    .map(|(_, w)| w)
                    .or_else(|| app.get_webview_window("main"));
                if let Some(w) = target {
                    let _ = w.emit("command", id);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_path,
            path_kind,
            reveal_in_finder,
            opened_paths,
            default_markdown_app,
            set_default_markdown_app,
            get_recents,
            save_recents,
            list_pages,
            read_page,
            write_page,
            delete_page,
            confirm,
            load_map,
            save_map,
            load_session,
            save_session,
            resolve_session,
            list_versions,
            read_version,
            snapshot_version,
            restore_version,
            delete_version,
            get_settings,
            save_settings,
            set_api_key,
            has_api_key,
            ai_stream,
            ai_cancel,
            ai_ping,
            send_feedback,
            read_dropped_image,
            check_for_update,
            install_update,
            relaunch,
            open_settings,
            open_page_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Ready => {
                    analytics::track_app_opened(app);
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
                    open_paths(app, paths);
                }
                // Cancel any AI stream still running (a Claude/Codex CLI child, or an HTTP
                // stream) so its reader task stops and its child is killed before the process
                // dies, instead of racing wry/WKWebView teardown on the way out.
                tauri::RunEvent::ExitRequested { .. } => {
                    let streams = app.state::<Streams>();
                    let tokens: Vec<CancelToken> = streams.0.lock().unwrap().drain().map(|(_, t)| t).collect();
                    for t in tokens {
                        t.cancel();
                    }
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
