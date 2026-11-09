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
mod pdf_extractor;
#[cfg(target_os = "macos")]
mod represented_url;
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

/// The paths each window's last native drop delivered, by window label, so `read_dropped_image`
/// reads only a file someone dropped there, not any image a script in the page names.
#[derive(Default)]
struct Dropped(Mutex<HashMap<String, Vec<std::path::PathBuf>>>);

impl Dropped {
    fn remember(&self, window: &str, paths: &[std::path::PathBuf]) {
        self.0.lock().unwrap().insert(window.to_owned(), paths.to_vec());
    }

    fn holds(&self, window: &str, path: &str) -> bool {
        self.0.lock().unwrap().get(window).is_some_and(|paths| paths.iter().any(|p| p == std::path::Path::new(path)))
    }
}

// ---------- files ----------

/// Folder only: Settings uses it for the default folder.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p.map(|p| p.to_string()));
    });
    rx.await.map_err(|_| AppError::Message("dialog closed".into()))
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
    rx.await.map_err(|_| AppError::Message("dialog closed".into()))
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
        rx.await.map_err(|_| AppError::Message("dialog closed".into()))
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

/// Opens a folder in the system file manager. Done here rather than via the webview's opener
/// plugin so the webview needs no `open-path` permission.
#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<()> {
    folder_to_open(&path)?;
    app.opener().open_path(&path, None::<&str>).map_err(|e| AppError::Message(e.to_string()))
}

/// A package (an `.app`, an `.rtfd`) is a folder on disk, but opening one runs the app or hands it to
/// one, so it is refused like a file. Packages are told apart the way Finder does it, not by a dot in
/// the name, so a folder called `grayscale.design` still opens.
fn folder_to_open(path: &str) -> Result<()> {
    if files::path_kind(path) != "folder" {
        return Err(AppError::Message(format!("not a folder: {}", path)));
    }
    if is_package(path) {
        return Err(AppError::Message(format!("not a folder: {path} is an app or package")));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_package(path: &str) -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().isFilePackageAtPath(&objc2_foundation::NSString::from_str(path))
}

#[cfg(not(target_os = "macos"))]
fn is_package(_path: &str) -> bool {
    false
}

/// The title bar follows the open session: its native proxy icon (right-click / ⌘-click for a
/// parent-folder menu) points at `path`, or clears when it's `None`.
#[tauri::command]
fn set_represented_path(window: tauri::WebviewWindow, path: Option<String>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        window
            .run_on_main_thread(move || represented_url::set(&target, path.as_deref()))
            .map_err(|e| AppError::Message(e.to_string()))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
    }
    Ok(())
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
fn write_new_page(folder: String, path: String, content: String) -> Result<bool> {
    files::write_new_page(&folder, &path, &content)
}

#[tauri::command]
fn delete_page(folder: String, path: String) -> Result<String> {
    files::delete_page(&folder, &path)
}

#[tauri::command]
fn restore_page(folder: String, path: String, trashed: String) -> Result<()> {
    files::restore_page(&folder, &path, &trashed)
}

#[tauri::command]
fn trash_count(folder: String) -> Result<u32> {
    files::trash_count(&folder)
}

#[tauri::command]
fn empty_trash(folder: String) -> Result<u32> {
    files::empty_trash(&folder)
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
/// window's native drag-drop hands over a path rather than a browser `File`. Only a path that drop
/// delivered is read: otherwise a script in the page could read any image on disk and, through
/// `send_feedback`, post it to the relay.
#[tauri::command]
fn read_dropped_image<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, path: String, dropped: State<'_, Dropped>) -> Result<feedback::Attachment> {
    if !dropped.holds(window.label(), &path) {
        return Err(AppError::Message("Drop the screenshot on the window to attach it.".into()));
    }
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

/// Resolves to whether the stream's last event (`done` or `error`) was sent on `channel`.
#[tauri::command]
async fn ai_stream(app: AppHandle, id: String, req: AiRequest, channel: Channel<StreamEvent>, streams: State<'_, Streams>) -> Result<bool> {
    let token = CancelToken::default();
    streams.0.lock().unwrap().insert(id.clone(), token.clone());
    if let Some(kind) = &req.kind {
        analytics::track_ai_ask(&app, kind);
    }
    let sent = ai::stream(req, channel, token).await;
    streams.0.lock().unwrap().remove(&id);
    Ok(sent)
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
    let label = free_page_label(|l| app.get_webview_window(l).is_some());
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

/// The first `page-N` no open window has. A count of the open windows is not enough: once an earlier
/// page window closes, the count lands on a label still in use, and Tauri refuses a second window with it.
fn free_page_label(open: impl Fn(&str) -> bool) -> String {
    (1..)
        .map(|n| format!("page-{n}"))
        .find(|l| !open(l))
        .expect("some page-N is free")
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
        .manage(Dropped::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<Dropped>().remember(window.label(), paths);
            }
        })
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
            open_folder,
            set_represented_path,
            opened_paths,
            default_markdown_app,
            set_default_markdown_app,
            get_recents,
            save_recents,
            list_pages,
            read_page,
            write_page,
            write_new_page,
            delete_page,
            restore_page,
            trash_count,
            empty_trash,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_window_label_is_one_no_open_window_has() {
        // Two page windows were opened, then the first was closed: three windows would have counted
        // out "page-2" again, which the second one still holds.
        let open = ["main", "page-2"];
        assert_eq!(free_page_label(|l| open.contains(&l)), "page-1");
        let open = ["main", "settings", "page-1", "page-2"];
        assert_eq!(free_page_label(|l| open.contains(&l)), "page-3");
    }

    #[test]
    fn open_folder_opens_plain_folders_and_refuses_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let path = |name: &str| {
            let p = tmp.path().join(name);
            std::fs::create_dir(&p).unwrap();
            p.to_str().unwrap().to_owned()
        };
        assert!(folder_to_open(&path("notes")).is_ok());
        // A dot in a folder's name doesn't make it a package; only kinds macOS opens with an app do.
        assert!(folder_to_open(&path("grayscale.design")).is_ok());
        // Launch Services would run an app bundle, or hand a document bundle to its app.
        let app = path("Calculator.app");
        assert_eq!(folder_to_open(&app).unwrap_err().to_string(), format!("not a folder: {app} is an app or package"));
        assert!(folder_to_open(&path("Report.rtfd")).is_err());
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        assert!(folder_to_open(tmp.path().join("a.md").to_str().unwrap()).is_err());
    }

    #[test]
    fn urlencode_keeps_path_characters_and_escapes_the_rest() {
        assert_eq!(
            urlencode("notes/Sleep replay.md"),
            "notes/Sleep%20replay.md"
        );
        assert_eq!(urlencode("a&b#c?d+e"), "a%26b%23c%3Fd%2Be");
        assert_eq!(urlencode("café"), "caf%C3%A9");
    }
}

/// The commands as the webview calls them: through Tauri's IPC, with the camelCase arguments
/// `src/platform/tauri.ts` sends, getting back the JSON (or the error text) it reads. Commands that
/// need the real app (dialogs, Finder, windows, the updater) are left to the app itself.
#[cfg(test)]
mod ipc {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn app() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .manage(Streams::default())
            .manage(Opened::default())
            .manage(Dropped::default())
            .invoke_handler(tauri::generate_handler![
                path_kind,
                opened_paths,
                list_pages,
                read_page,
                write_page,
                write_new_page,
                delete_page,
                restore_page,
                load_map,
                save_map,
                load_session,
                save_session,
                list_versions,
                read_version,
                snapshot_version,
                restore_version,
                delete_version,
                has_api_key,
                ai_cancel,
                read_dropped_image,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        (app, window)
    }

    fn call(window: &tauri::WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> std::result::Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(window, request).map(|b| b.deserialize::<Value>().unwrap())
    }

    fn dir_str(p: &Path) -> String {
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn pages_are_written_read_and_listed() {
        let (_app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        let folder = dir_str(tmp.path());
        let page = json!({ "folder": folder, "path": "notes/a.md", "content": "# A\n" });
        assert_eq!(call(&w, "write_new_page", page.clone()), Ok(json!(true)));
        assert_eq!(call(&w, "write_new_page", page), Ok(json!(false)), "a page already there stays");
        assert_eq!(call(&w, "write_page", json!({ "folder": folder, "path": "notes/a.md", "content": "# A, again\n" })), Ok(Value::Null));

        let read = call(&w, "read_page", json!({ "folder": folder, "path": "notes/a.md" })).unwrap();
        assert_eq!(read["path"], "notes/a.md");
        assert_eq!(read["raw"], "# A, again\n");
        assert!(read["modified"].is_string());
        let listed = call(&w, "list_pages", json!({ "folder": folder })).unwrap();
        let paths: Vec<&str> = listed.as_array().unwrap().iter().map(|p| p["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec!["notes/a.md"]);
    }

    #[test]
    fn a_refusal_reaches_the_webview_as_its_reason() {
        let (_app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        let folder = dir_str(tmp.path());
        std::fs::write(tmp.path().join("notes.txt"), "plain").unwrap();
        assert_eq!(
            call(&w, "write_page", json!({ "folder": folder, "path": "../escape.md", "content": "x" })),
            Err(json!("Refusing path outside the folder: ../escape.md"))
        );
        assert!(!tmp.path().parent().unwrap().join("escape.md").exists());
        assert_eq!(call(&w, "read_page", json!({ "folder": folder, "path": "notes.txt" })), Err(json!("Unsupported file type: notes.txt")));
        assert_eq!(
            call(&w, "write_page", json!({ "folder": folder, "path": "paper.pdf", "content": "x" })),
            Err(json!("Cannot write to read-only file type: paper.pdf. Create a companion .md file instead."))
        );
        let file = dir_str(&tmp.path().join("notes.txt"));
        assert_eq!(call(&w, "list_pages", json!({ "folder": file })), Err(json!(format!("Not a folder: {file}"))));
        // A missing argument is refused before the command runs.
        assert!(call(&w, "read_page", json!({ "folder": folder })).is_err());
    }

    #[test]
    fn a_deleted_page_comes_back_from_the_trash() {
        let (_app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        let folder = dir_str(tmp.path());
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let trashed = call(&w, "delete_page", json!({ "folder": folder, "path": "a.md" })).unwrap();
        assert_eq!(trashed, json!("a"));
        assert!(!tmp.path().join("a.md").exists());
        assert_eq!(call(&w, "delete_page", json!({ "folder": folder, "path": "a.md" })), Err(json!("No such page: a.md")));
        assert_eq!(call(&w, "restore_page", json!({ "folder": folder, "path": "a.md", "trashed": trashed })), Ok(Value::Null));
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.md")).unwrap(), "# A\n");
    }

    #[test]
    fn versions_are_snapshotted_listed_read_restored_and_deleted() {
        let (_app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        let folder = dir_str(tmp.path());
        std::fs::write(tmp.path().join("a.md"), "# First\n").unwrap();
        let at = json!({ "folder": folder, "path": "a.md" });
        assert_eq!(call(&w, "snapshot_version", at.clone()), Ok(json!(1)));
        std::fs::write(tmp.path().join("a.md"), "# Second\n").unwrap();

        let listed = call(&w, "list_versions", at.clone()).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["n"], 1);
        assert!(listed[0]["at"].is_string());
        let one = json!({ "folder": folder, "path": "a.md", "n": 1 });
        assert_eq!(call(&w, "read_version", one.clone()), Ok(json!("# First\n")));
        assert_eq!(call(&w, "restore_version", one.clone()), Ok(Value::Null));
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.md")).unwrap(), "# First\n");
        assert_eq!(call(&w, "delete_version", one), Ok(Value::Null));
        let left = call(&w, "list_versions", at).unwrap();
        assert!(left.as_array().unwrap().iter().all(|v| v["n"] != 1), "{left}");
    }

    #[test]
    fn session_state_and_the_map_round_trip() {
        let (_app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        let folder = dir_str(tmp.path());
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        assert_eq!(call(&w, "load_session", json!({ "folder": folder, "file": null })), Ok(Value::Null));
        let session = json!({ "open": ["a.md"] });
        assert_eq!(call(&w, "save_session", json!({ "folder": folder, "session": session, "file": null })), Ok(Value::Null));
        let back = call(&w, "load_session", json!({ "folder": folder })).unwrap();
        assert_eq!(back["open"], json!(["a.md"]));
        assert!(back["ids"]["a.md"].is_string(), "the save records each page's file id: {back}");
        // A session opened from one file keeps its own state.
        assert_eq!(call(&w, "load_session", json!({ "folder": folder, "file": "a.md" })), Ok(Value::Null));

        assert_eq!(call(&w, "load_map", json!({ "folder": folder })), Ok(Value::Null));
        let cache = json!({ "a.md": { "summary": "A page.", "hash": "x" } });
        assert_eq!(call(&w, "save_map", json!({ "folder": folder, "cache": cache, "rendered": "- a.md: A page.\n" })), Ok(Value::Null));
        assert_eq!(call(&w, "load_map", json!({ "folder": folder })), Ok(cache));
        assert_eq!(std::fs::read_to_string(tmp.path().join(".reader/map.md")).unwrap(), "- a.md: A page.\n");
    }

    #[test]
    fn files_opened_before_the_reader_listens_are_handed_over_once() {
        let (app, w) = app();
        app.state::<Opened>().paths.lock().unwrap().extend(["/notes/a.md".to_string(), "/notes".to_string()]);
        assert_eq!(call(&w, "opened_paths", json!({})), Ok(json!(["/notes/a.md", "/notes"])));
        assert!(app.state::<Opened>().ready.load(Ordering::SeqCst), "later opens go straight to the window");
        assert_eq!(call(&w, "opened_paths", json!({})), Ok(json!([])));
    }

    #[test]
    fn ai_cancel_stops_that_stream_and_ignores_one_already_gone() {
        let (app, w) = app();
        let token = CancelToken::default();
        app.state::<Streams>().0.lock().unwrap().insert("ask-1".into(), token.clone());
        assert_eq!(call(&w, "ai_cancel", json!({ "id": "ask-1" })), Ok(Value::Null));
        assert!(token.is_cancelled());
        assert!(app.state::<Streams>().0.lock().unwrap().is_empty());
        assert_eq!(call(&w, "ai_cancel", json!({ "id": "ask-1" })), Ok(Value::Null));
    }

    #[test]
    fn path_kinds_keys_and_dropped_files() {
        let (app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "plain").unwrap();
        let kind = |p: &Path| call(&w, "path_kind", json!({ "path": dir_str(p) })).unwrap();
        assert_eq!(kind(tmp.path()), json!("folder"));
        assert_eq!(kind(&tmp.path().join("a.md")), json!("file"));
        assert_eq!(kind(&tmp.path().join("a.txt")), json!("other"));
        assert_eq!(kind(&tmp.path().join("gone.md")), json!("other"));

        assert_eq!(call(&w, "has_api_key", json!({ "provider": "ipc-test" })), Ok(json!(false)));
        crate::ai::TEST_KEYS.lock().unwrap().push(("ipc-test".into(), "k".into()));
        assert_eq!(call(&w, "has_api_key", json!({ "provider": "ipc-test" })), Ok(json!(true)));

        std::fs::write(tmp.path().join("shot.png"), b"png").unwrap();
        app.state::<Dropped>().remember("main", &[tmp.path().join("a.txt"), tmp.path().join("shot.png")]);
        assert_eq!(
            call(&w, "read_dropped_image", json!({ "path": dir_str(&tmp.path().join("a.txt")) })),
            Err(json!("Drop a screenshot (PNG, JPEG, GIF or WebP)."))
        );
        let shot = call(&w, "read_dropped_image", json!({ "path": dir_str(&tmp.path().join("shot.png")) })).unwrap();
        assert_eq!(shot, json!({ "name": "shot.png", "mime": "image/png", "data": "cG5n" }));
    }

    #[test]
    fn only_an_image_dropped_on_the_window_is_read() {
        let (app, w) = app();
        let tmp = tempfile::tempdir().unwrap();
        for name in ["dropped.png", "other.png"] {
            std::fs::write(tmp.path().join(name), b"png").unwrap();
        }
        let read = |name: &str| call(&w, "read_dropped_image", json!({ "path": dir_str(&tmp.path().join(name)) }));
        let refused = Err(json!("Drop the screenshot on the window to attach it."));
        // Nothing dropped yet: a script in the page naming a screenshot on disk gets nothing.
        assert_eq!(read("dropped.png"), refused);

        app.state::<Dropped>().remember("main", &[tmp.path().join("dropped.png")]);
        assert_eq!(read("dropped.png").unwrap()["name"], "dropped.png");
        assert_eq!(read("other.png"), refused);
        // A drop on another window doesn't open this one's reach.
        app.state::<Dropped>().remember("page-1", &[tmp.path().join("other.png")]);
        assert_eq!(read("other.png"), refused);
        // The next drop replaces the last one.
        app.state::<Dropped>().remember("main", &[tmp.path().join("other.png")]);
        assert_eq!(read("dropped.png"), refused);
    }
}
