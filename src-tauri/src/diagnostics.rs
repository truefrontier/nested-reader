//! Local, redacted support diagnostics. Archives are saved by the user and never uploaded.

use crate::error::{AppError, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub const LOG_FILE_NAME: &str = "nested";
pub const SUPPORT_LOG_TARGET: &str = "nested_support";
pub const MAX_LOG_FILE_SIZE: u128 = 1_000_000;
pub const LOG_FILES_TO_KEEP: usize = 3;
const MAX_LOG_BYTES: u64 = 2_000_000;

static SECRET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(?P<key>\b(?:api[_-]?key|secret|token|password|authorization|cookie)\b\s*(?:=|:)\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"#).unwrap());
static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap());
static HOME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/(?:Users|home)/[^/\s]+(?:/[^\s]*)?").unwrap());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport { path: String, log_files: usize }

pub async fn export_diagnostics(app: AppHandle) -> Result<Option<DiagnosticsExport>> {
    let name = format!("nested-diagnostics-{}.zip", unix_time());
    let Some(path) = app.dialog().file().set_title("Export diagnostics").set_file_name(name).add_filter("ZIP archive", &["zip"]).blocking_save_file() else {
        return Ok(None);
    };
    let destination = path.into_path().map_err(|_| AppError::Message("The selected diagnostics destination is not a local file.".into()))?;
    let settings = crate::settings_path(&app)?;
    let logs = app.path().app_log_dir()?;
    let count = write_archive(&destination, &settings, &logs, &app)?;
    log::info!(target: SUPPORT_LOG_TARGET, "diagnostics_export_completed log_files={count}");
    Ok(Some(DiagnosticsExport { path: destination.to_string_lossy().into_owned(), log_files: count }))
}

fn write_archive(destination: &Path, settings_path: &Path, log_dir: &Path, app: &AppHandle) -> Result<usize> {
    let temporary = destination.with_extension("zip.tmp");
    let file = File::create(&temporary)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o600);
    let manifest = json!({ "schemaVersion": 1, "appName": app.package_info().name, "appVersion": app.package_info().version.to_string(), "appIdentifier": app.config().identifier, "os": std::env::consts::OS, "arch": std::env::consts::ARCH });
    write_json(&mut zip, "manifest.json", &manifest, options)?;
    write_json(&mut zip, "settings.redacted.json", &redacted_settings(settings_path), options)?;
    write_text(&mut zip, "README.txt", "Nested diagnostics\n\nCreated locally for support. Nothing was uploaded. Keychain data is never read; settings are allowlisted and logs are redacted. Review this archive before attaching it to feedback.\n", options)?;
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(log_dir) {
        let mut paths = entries.filter_map(std::result::Result::ok).filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) && entry.file_name().to_string_lossy().starts_with(LOG_FILE_NAME)).collect::<Vec<_>>();
        paths.sort_by_key(|entry| std::cmp::Reverse(entry.metadata().and_then(|meta| meta.modified()).ok()));
        for entry in paths.into_iter().take(LOG_FILES_TO_KEEP) {
            if let Ok(file) = OpenOptions::new().read(true).open(entry.path()) {
                let mut bytes = Vec::new();
                file.take(MAX_LOG_BYTES).read_to_end(&mut bytes)?;
                count += 1;
                write_text(&mut zip, &format!("logs/support-{count}.log"), &redact(&String::from_utf8_lossy(&bytes)), options)?;
            }
        }
    }
    zip.finish().map_err(|error| AppError::Message(error.to_string()))?.sync_all()?;
    fs::rename(temporary, destination)?;
    Ok(count)
}

fn write_json<T: Serialize>(zip: &mut ZipWriter<File>, name: &str, value: &T, options: SimpleFileOptions) -> Result<()> { let mut body = serde_json::to_vec_pretty(value)?; body.push(b'\n'); zip.start_file(name, options).map_err(|error| AppError::Message(error.to_string()))?; zip.write_all(&body)?; Ok(()) }
fn write_text(zip: &mut ZipWriter<File>, name: &str, body: &str, options: SimpleFileOptions) -> Result<()> { zip.start_file(name, options).map_err(|error| AppError::Message(error.to_string()))?; zip.write_all(body.as_bytes())?; Ok(()) }
fn redacted_settings(path: &Path) -> Value {
    let Some(Value::Object(stored)) = fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()) else { return json!({ "status": "not-available", "values": {} }); };
    let mut values = Map::new();
    for key in ["theme", "analyticsEnabled", "crashReportingEnabled", "openAtLaunch", "readingFont", "textSize"] { if let Some(value) = stored.get(key) { values.insert(key.into(), value.clone()); } }
    values.insert("configuredProviders".into(), json!(stored.get("models").and_then(Value::as_object).map(|models| models.values().filter(|value| value.as_str().is_some_and(|model| !model.is_empty())).count()).unwrap_or(0)));
    json!({ "status": "available", "values": values })
}
fn redact(input: &str) -> String { HOME.replace_all(&EMAIL.replace_all(&SECRET.replace_all(input, "${key}[REDACTED]"), "[REDACTED_EMAIL]"), "[REDACTED_HOME]").into_owned() }
fn unix_time() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }

#[cfg(test)]
mod tests { use super::*; #[test] fn redacts_common_private_values() { let output = redact("token=secret me@example.com /Users/kevin/notes"); assert!(!output.contains("secret") && !output.contains("me@example.com") && !output.contains("/Users/kevin")); } }
