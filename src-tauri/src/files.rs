//! Reading and writing the session folder: pages, session state and versions.

use crate::error::{AppError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const READER_DIR: &str = ".reader";

#[derive(Serialize, Deserialize, Clone)]
pub struct RawPage {
    pub path: String,
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct VersionInfo {
    pub n: u32,
    pub at: String,
}

fn iso(t: std::io::Result<std::time::SystemTime>) -> Option<String> {
    t.ok().map(|t| DateTime::<Utc>::from(t).to_rfc3339())
}

/// Rejects paths that escape the folder.
fn safe_join(folder: &str, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Message(format!("Refusing path outside the folder: {rel}")));
    }
    Ok(Path::new(folder).join(rel_path))
}

fn rel_string(folder: &Path, full: &Path) -> Option<String> {
    full.strip_prefix(folder).ok().map(|p| p.to_string_lossy().replace('\\', "/"))
}

pub fn list_pages(folder: &str) -> Result<Vec<RawPage>> {
    let root = Path::new(folder);
    if !root.is_dir() {
        return Err(AppError::Message(format!("Not a folder: {folder}")));
    }
    let mut out = Vec::new();
    // Hidden directories and node_modules are skipped, but never the root itself, whatever it is called.
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        e.depth() == 0 || !(name.starts_with('.') || name == "node_modules")
    });
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !is_markdown(path) {
            continue;
        }
        let Some(rel) = rel_string(root, path) else { continue };
        let raw = fs::read_to_string(path)?;
        let meta = entry.metadata().ok();
        out.push(RawPage {
            path: rel,
            raw,
            modified: meta.as_ref().and_then(|m| iso(m.modified())),
            created: meta.as_ref().and_then(|m| iso(m.created())),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn read_page(folder: &str, rel: &str) -> Result<RawPage> {
    let full = safe_join(folder, rel)?;
    let raw = fs::read_to_string(&full)?;
    let meta = fs::metadata(&full).ok();
    Ok(RawPage {
        path: rel.to_string(),
        raw,
        modified: meta.as_ref().and_then(|m| iso(m.modified())),
        created: meta.as_ref().and_then(|m| iso(m.created())),
    })
}

/// Atomic write: temp file in the same directory, then rename over the target.
pub fn write_atomic(full: &Path, content: &str) -> Result<()> {
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = full.with_extension(format!(
        "{}.tmp-{}",
        full.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
        std::process::id()
    ));
    fs::write(&tmp, content)?;
    fs::rename(&tmp, full)?;
    Ok(())
}

pub fn write_page(folder: &str, rel: &str, content: &str) -> Result<()> {
    let full = safe_join(folder, rel)?;
    write_atomic(&full, content)
}

/// Takes a page out of the folder: its file and its version snapshots are moved into
/// `.reader/trash/`, rather than removed, so a delete can still be undone by hand in Finder.
/// A name already sitting in the trash gets `-2`, `-3`, and so on.
pub fn delete_page(folder: &str, rel: &str) -> Result<()> {
    let full = safe_join(folder, rel)?;
    if !full.is_file() {
        return Err(AppError::Message(format!("No such page: {rel}")));
    }
    let trash = reader_dir(folder).join("trash");
    fs::create_dir_all(&trash)?;
    let stem = full.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "page".into());
    let ext = full.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "md".into());
    // The page and its snapshots are parked under one name, so they can be told apart and put back together.
    let mut name = stem.clone();
    let mut i = 2;
    while trash.join(format!("{name}.{ext}")).exists() || trash.join(format!("{name}-versions")).exists() {
        name = format!("{stem}-{i}");
        i += 1;
    }
    fs::rename(&full, trash.join(format!("{name}.{ext}")))?;
    let versions = versions_dir(folder, rel)?;
    if versions.is_dir() {
        // The page is already out of the way; snapshots left behind are stale, not a failure.
        let _ = fs::rename(&versions, trash.join(format!("{name}-versions")));
    }
    Ok(())
}

fn reader_dir(folder: &str) -> PathBuf {
    Path::new(folder).join(READER_DIR)
}

/// A page path flattened into one file-name segment: `notes/a.md` -> `notes__a`.
fn page_key(rel: &str) -> String {
    rel.trim_end_matches(".md").replace(['/', '\\'], "__")
}

/// `.reader/session.json` for a folder session; a session opened from one file
/// inside the folder keeps its own state in `.reader/session-<page>.json`.
fn session_path(folder: &str, file: Option<&str>) -> Result<PathBuf> {
    let dir = reader_dir(folder);
    Ok(match file {
        None => dir.join("session.json"),
        Some(rel) => {
            safe_join(folder, rel)?;
            dir.join(format!("session-{}.json", page_key(rel)))
        }
    })
}

pub fn load_session(folder: &str, file: Option<&str>) -> Result<Option<serde_json::Value>> {
    let path = session_path(folder, file)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

pub fn save_session(folder: &str, session: &serde_json::Value, file: Option<&str>) -> Result<()> {
    let path = session_path(folder, file)?;
    write_atomic(&path, &serde_json::to_string_pretty(session)?)
}

fn versions_dir(folder: &str, rel: &str) -> Result<PathBuf> {
    safe_join(folder, rel)?;
    Ok(reader_dir(folder).join("versions").join(page_key(rel)))
}

/// Whether a dropped path is a folder, a Markdown file, or something the reader cannot open.
pub fn path_kind(path: &str) -> &'static str {
    let p = Path::new(path);
    if p.is_dir() {
        "folder"
    } else if p.is_file() && is_markdown(p) {
        "file"
    } else {
        "other"
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

pub fn list_versions(folder: &str, rel: &str) -> Result<Vec<VersionInfo>> {
    let dir = versions_dir(folder, rel)?;
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir)?.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(num) = name.strip_prefix('v').and_then(|s| s.strip_suffix(".md")) else { continue };
        let Ok(n) = num.parse::<u32>() else { continue };
        let at = entry.metadata().ok().and_then(|m| iso(m.modified())).unwrap_or_default();
        out.push(VersionInfo { n, at });
    }
    out.sort_by_key(|v| v.n);
    Ok(out)
}

pub fn read_version(folder: &str, rel: &str, n: u32) -> Result<String> {
    let path = versions_dir(folder, rel)?.join(format!("v{n}.md"));
    Ok(fs::read_to_string(path)?)
}

pub fn snapshot_version(folder: &str, rel: &str) -> Result<u32> {
    let current = fs::read_to_string(safe_join(folder, rel)?)?;
    let n = list_versions(folder, rel)?.last().map(|v| v.n).unwrap_or(0) + 1;
    let path = versions_dir(folder, rel)?.join(format!("v{n}.md"));
    write_atomic(&path, &current)?;
    Ok(n)
}

pub fn restore_version(folder: &str, rel: &str, n: u32) -> Result<()> {
    let content = read_version(folder, rel, n)?;
    write_page(folder, rel, &content)?;
    for v in list_versions(folder, rel)? {
        if v.n >= n {
            let _ = fs::remove_file(versions_dir(folder, rel)?.join(format!("v{}.md", v.n)));
        }
    }
    Ok(())
}

pub fn delete_version(folder: &str, rel: &str, n: u32) -> Result<()> {
    let path = versions_dir(folder, rel)?.join(format!("v{n}.md"));
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
