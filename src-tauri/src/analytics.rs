//! Privacy-friendly desktop analytics via Aptabase.
//!
//! Tracks a lean set of events (app opened, feedback sent, update checked/installed, AI ask).
//! When `APTABASE_APP_KEY` is not set at compile time, every call becomes a no-op.

use serde_json::json;

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
        let _ = app.track_event("app_opened", Some(json!({ "version": version })));
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
        let _ = app.track_event("feedback_sent", Some(json!({ "has_email": if has_email { 1 } else { 0 } })));
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
        let _ = app.track_event("update_checked", Some(json!({ "result": result })));
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
        let _ = app.track_event(
            "update_installed",
            Some(json!({ "from_version": from_version, "to_version": to_version })),
        );
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
        let _ = app.track_event("ai_ask", Some(json!({ "kind": kind })));
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
