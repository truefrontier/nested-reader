//! Privacy-friendly desktop analytics via Aptabase.
//!
//! Tracks a lean set of events (app opened, feedback sent, update checked/installed, AI ask).
//! When `APTABASE_APP_KEY` is not set at compile time, every call becomes a no-op.

use serde_json::json;
use tauri::{AppHandle, Manager};

/// Compiled in from the environment; when absent or empty, tracking is disabled.
pub const APP_KEY: Option<&str> = option_env!("APTABASE_APP_KEY");

/// Whether tracking is enabled (i.e. an app key was compiled in).
pub fn key_configured() -> bool {
    cfg!(feature = "aptabase") && APP_KEY.is_some_and(|key| !key.trim().is_empty())
}

/// The preference is deliberately read for every event: an opt-out takes effect without restart.
/// Unreadable manually-edited settings fail closed instead of accidentally tracking.
fn user_enabled(app: &AppHandle) -> bool {
    let Ok(path) = app.path().app_config_dir().map(|dir| dir.join("settings.json")) else {
        return false;
    };
    if !path.exists() {
        return true;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    match settings.get("analyticsEnabled") {
        None => true,
        Some(serde_json::Value::Bool(enabled)) => *enabled,
        Some(_) => false,
    }
}

pub fn enabled(app: &AppHandle) -> bool {
    key_configured() && user_enabled(app)
}

/// Tracks `app_opened` with the app version.
pub fn track_app_opened(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let version = app.package_info().version.to_string();
        let _ = app.track_event("app_opened", Some(json!({ "version": version })));
    }
}

/// Tracks `feedback_sent` with whether an email was provided (0 or 1).
pub fn track_feedback_sent(app: &AppHandle, has_email: bool) {
    if !enabled(app) {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let _ = app.track_event("feedback_sent", Some(json!({ "has_email": if has_email { 1 } else { 0 } })));
    }
}

/// Tracks `update_checked` with the result: `latest`, `available`, `unsupported`, or `error`.
pub fn track_update_checked(app: &AppHandle, result: &str) {
    if !enabled(app) {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let _ = app.track_event("update_checked", Some(json!({ "result": result })));
    }
}

/// Tracks `update_installed` with the from and to versions.
pub fn track_update_installed(app: &AppHandle, from_version: &str, to_version: &str) {
    if !enabled(app) {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let _ = app.track_event(
            "update_installed",
            Some(json!({ "from_version": from_version, "to_version": to_version })),
        );
    }
}

/// Tracks `ai_ask` with the kind: `quick_answer`, `new_page`, `deep_dive`, `refine`, or `summary` (indexing, one per batch of pages).
pub fn track_ai_ask(app: &AppHandle, kind: &str) {
    if !enabled(app) {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let _ = app.track_event("ai_ask", Some(json!({ "kind": kind })));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_requires_a_nonempty_value() {
        // This tests the logic; the actual compile-time value depends on the environment.
        assert_eq!(key_configured(), cfg!(feature = "aptabase") && APP_KEY.is_some_and(|key| !key.trim().is_empty()));
    }
}
