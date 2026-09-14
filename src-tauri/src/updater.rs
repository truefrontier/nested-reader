//! App updates: the updater plugin asks the relay in `feedback-relay/` for the newest release,
//! downloads the signed bundle and swaps it in; the reader then relaunches. The relay holds the
//! GitHub token the private repository needs, so the app carries only the relay's URL and the
//! public half of the signing key (both in `tauri.conf.json`).

use crate::error::{AppError, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept so Install needs no second round trip, and a flag
/// so two windows cannot install at once.
#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<Update>>,
    installing: AtomicBool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// What a check found: the running version, whether this build can update itself at all, and
/// the newer version when there is one.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateInfo>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UpdateProgress {
    #[serde(rename_all = "camelCase")]
    Progress { downloaded: u64, total: Option<u64> },
    Installed,
}

/// `tauri dev` runs a bare debug executable, not an installed bundle, so there is nothing to replace.
pub const SUPPORTED: bool = !cfg!(debug_assertions);

/// Asks the relay for the newest release and remembers it for `install`.
pub async fn check(app: &AppHandle, pending: &Pending) -> Result<UpdateCheck> {
    let current = app.package_info().version.to_string();
    if !SUPPORTED {
        crate::analytics::track_update_checked(app, "unsupported");
        return Ok(UpdateCheck { current, supported: false, update: None });
    }
    let updater = app.updater().map_err(describe)?;
    let result = updater.check().await;
    match result {
        Ok(found) => {
            let has_update = found.is_some();
            let update = found.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: notes_of(u.body.as_deref()) });
            *pending.update.lock().unwrap() = found;
            crate::analytics::track_update_checked(app, if has_update { "available" } else { "latest" });
            Ok(UpdateCheck { current, supported: true, update })
        }
        Err(e) => {
            crate::analytics::track_update_checked(app, "error");
            Err(describe(e))
        }
    }
}

/// Downloads and installs the update the last check found, reporting progress on the channel.
/// The caller relaunches afterwards.
pub async fn install(pending: &Pending, channel: Channel<UpdateProgress>, app: &AppHandle) -> Result<()> {
    let update = pending.update.lock().unwrap().clone().ok_or_else(|| AppError::Message("Check for updates first.".into()))?;
    if pending.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::Message("An update is already installing.".into()));
    }
    let from_version = app.package_info().version.to_string();
    let to_version = update.version.clone();
    let downloaded = std::sync::atomic::AtomicU64::new(0);
    let result = update
        .download_and_install(
            |chunk, total| {
                let so_far = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = channel.send(UpdateProgress::Progress { downloaded: so_far, total });
            },
            || {
                let _ = channel.send(UpdateProgress::Installed);
            },
        )
        .await
        .map_err(describe);
    pending.installing.store(false, Ordering::SeqCst);
    if result.is_ok() {
        *pending.update.lock().unwrap() = None;
        crate::analytics::track_update_installed(app, &from_version, &to_version);
    }
    result
}

/// Release notes worth showing: trimmed, and left out when the release has none.
pub fn notes_of(body: Option<&str>) -> Option<String> {
    body.map(str::trim).filter(|b| !b.is_empty()).map(str::to_owned)
}

/// The updater's errors as sentences the bar can show.
fn describe(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error;
    let message = match &e {
        Error::Reqwest(r) if r.is_timeout() => "The update server didn't answer in time.".to_owned(),
        Error::Reqwest(r) if r.is_connect() => "Couldn't reach the update server. Are you online?".to_owned(),
        Error::Reqwest(r) => format!("The update server refused the request ({}).", r.status().map(|s| s.as_u16().to_string()).unwrap_or_else(|| "no status".into())),
        Error::Network(why) => format!("Couldn't download the update: {why}"),
        Error::Minisign(_) | Error::SignatureUtf8(_) => "The update's signature didn't verify, so it was not installed.".to_owned(),
        Error::Io(io) => format!("Couldn't install the update: {io}"),
        other => other.to_string(),
    };
    AppError::Message(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_drop_blank_bodies() {
        assert_eq!(notes_of(None), None);
        assert_eq!(notes_of(Some("  \n")), None);
        assert_eq!(notes_of(Some("\nFixes the tree.\n")).as_deref(), Some("Fixes the tree."));
    }

    #[test]
    fn check_and_progress_serialize_in_camel_case() {
        let check = UpdateCheck { current: "0.1.0".into(), supported: true, update: Some(UpdateInfo { version: "0.2.0".into(), notes: None }) };
        let json = serde_json::to_string(&check).unwrap();
        assert!(json.contains(r#""current":"0.1.0""#));
        assert!(json.contains(r#""supported":true"#));
        assert!(json.contains(r#""update":{"version":"0.2.0"}"#));
        let p = serde_json::to_string(&UpdateProgress::Progress { downloaded: 3, total: None }).unwrap();
        assert_eq!(p, r#"{"type":"progress","downloaded":3,"total":null}"#);
        assert_eq!(serde_json::to_string(&UpdateProgress::Installed).unwrap(), r#"{"type":"installed"}"#);
    }

    #[test]
    fn a_debug_build_reports_itself_unsupported() {
        assert_eq!(SUPPORTED, !cfg!(debug_assertions));
    }
}
