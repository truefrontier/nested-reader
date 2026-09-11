mod ai;
mod cli;
mod error;
mod files;
mod migrate;
#[cfg(target_os = "macos")]
mod open_panel;

use ai::tokio_util_lite::CancelToken;
use ai::{AiRequest, PingResult, StreamEvent};
use error::{AppError, Result};
use files::{RawPage, VersionInfo};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Streams(Mutex<HashMap<String, CancelToken>>);

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

/// ⌘O: one Open panel for both kinds of session, a folder or a single Markdown file.
#[tauri::command]
async fn pick_path(app: AppHandle) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(open_panel::folder_or_markdown());
        })
        .map_err(|e| AppError::Message(e.to_string()))?;
        Ok(rx.await.map_err(|_| AppError::Message("dialog closed".into()))?)
    }
    // Other platforms have no panel that takes both, so they get the folder picker.
    #[cfg(not(target_os = "macos"))]
    pick_folder(app).await
}

#[tauri::command]
fn path_kind(path: String) -> &'static str {
    files::path_kind(&path)
}

#[tauri::command]
fn reveal_in_finder(app: AppHandle, path: String) -> Result<()> {
    app.opener().reveal_item_in_dir(&path).map_err(|e| AppError::Message(e.to_string()))
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
fn load_session(folder: String, file: Option<String>) -> Result<Option<Value>> {
    files::load_session(&folder, file.as_deref())
}

#[tauri::command]
fn save_session(folder: String, session: Value, file: Option<String>) -> Result<()> {
    files::save_session(&folder, &session, file.as_deref())
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

// ---------- AI ----------

#[tauri::command]
async fn ai_stream(id: String, req: AiRequest, channel: Channel<StreamEvent>, streams: State<'_, Streams>) -> Result<()> {
    let token = CancelToken::default();
    streams.0.lock().unwrap().insert(id.clone(), token.clone());
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
        .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(16.0, 16.0)));
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
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Nested")
        .item(&about)
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
    let close_pane = MenuItemBuilder::with_id("close-pane", "Close Pane").accelerator("CmdOrCtrl+W").build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_page)
        .separator()
        .item(&open)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Streams::default())
        .setup(|app| {
            migrate::run(app.handle());
            build_menu(app.handle())?;
            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                if id == "settings" {
                    let _ = show_settings(app);
                    return;
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
            get_recents,
            save_recents,
            list_pages,
            read_page,
            write_page,
            load_session,
            save_session,
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
            open_settings,
            open_page_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
