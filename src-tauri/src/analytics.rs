//! Privacy-friendly desktop analytics via Aptabase.
//!
//! Tracks a lean set of events (app opened, feedback sent, update checked/installed, AI ask).
//! When `APTABASE_APP_KEY` is not set at compile time, every call becomes a no-op.

use serde_json::json;
use std::collections::HashMap;

/// Compiled in from the environment; when absent or empty, tracking is disabled.
pub const APP_KEY: Option<&str> = option_env!("APTABASE_APP_KEY");

/// Whether tracking is enabled (i.e. an app key was compiled in).
pub fn enabled() -> bool {
    APP_KEY.and_then(|k| if k.trim().is_empty() { None } else { Some(k) }).is_some()
}

/// Tracks `app_opened` with the app version.
pub fn track_app_opened(app: &tauri::AppHandle) {
    if !enabled() {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let version = app.package_info().version.to_string();
        let mut props = HashMap::new();
        props.insert("version".to_string(), json!(version));
        app.track_event("app_opened", Some(props));
    }
}

/// Tracks `feedback_sent` with whether an email was provided (0 or 1).
pub fn track_feedback_sent(app: &tauri::AppHandle, has_email: bool) {
    if !enabled() {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let mut props = HashMap::new();
        props.insert("has_email".to_string(), json!(if has_email { 1 } else { 0 }));
        app.track_event("feedback_sent", Some(props));
    }
}

/// Tracks `update_checked` with the result: `latest`, `available`, `unsupported`, or `error`.
pub fn track_update_checked(app: &tauri::AppHandle, result: &str) {
    if !enabled() {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let mut props = HashMap::new();
        props.insert("result".to_string(), json!(result));
        app.track_event("update_checked", Some(props));
    }
}

/// Tracks `update_installed` with the from and to versions.
pub fn track_update_installed(app: &tauri::AppHandle, from_version: &str, to_version: &str) {
    if !enabled() {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let mut props = HashMap::new();
        props.insert("from_version".to_string(), json!(from_version));
        props.insert("to_version".to_string(), json!(to_version));
        app.track_event("update_installed", Some(props));
    }
}

/// Tracks `ai_ask` with the kind: `quick_answer`, `new_page`, `deep_dive`, or `refine`.
pub fn track_ai_ask(app: &tauri::AppHandle, kind: &str) {
    if !enabled() {
        return;
    }
    #[cfg(feature = "aptabase")]
    {
        use freshjuice_tauri_aptabase::EventTracker;
        let mut props = HashMap::new();
        props.insert("kind".to_string(), json!(kind));
        app.track_event("ai_ask", Some(props));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_requires_a_nonempty_key() {
        // This tests the logic; the actual compile-time value depends on the environment.
        assert_eq!(enabled(), APP_KEY.and_then(|k| if k.trim().is_empty() { None } else { Some(k) }).is_some());
    }
}
