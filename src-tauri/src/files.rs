//! Reading and writing the session folder: pages, session state and versions.

use crate::error::{AppError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
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

/// What `resolve_session` found: the folder and file to open, and every relative path
/// that moved (`[from, to]`). `folderId` / `fileId` are Unix `dev:ino`; `bookmark` is a
/// Mac NSURL bookmark for the folder, when one could be made or refreshed.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSession {
    pub folder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub remaps: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
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
        if !is_openable_page(path) {
            continue;
        }
        let Some(rel) = rel_string(root, path) else { continue };
        let raw = if is_markdown(path) {
            fs::read_to_string(path)?
        } else if is_pdf(path) {
            extract_pdf_text(path)?
        } else if is_html(path) {
            extract_html_text(path)?
        } else {
            continue;
        };
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
    let raw = if is_markdown(&full) {
        fs::read_to_string(&full)?
    } else if is_pdf(&full) {
        extract_pdf_text(&full)?
    } else if is_html(&full) {
        extract_html_text(&full)?
    } else {
        return Err(AppError::Message(format!("Unsupported file type: {}", rel)));
    };
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
    // PDF and HTML files are read-only; prevent writing to them
    if is_pdf(&full) || is_html(&full) {
        return Err(AppError::Message(format!(
            "Cannot write to read-only file type: {}. Create a companion .md file instead.",
            rel
        )));
    }
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

pub fn save_session(folder: &str, session: &Value, file: Option<&str>) -> Result<()> {
    let mut session = session.clone();
    if let Some(obj) = session.as_object_mut() {
        obj.insert("ids".into(), json!(collect_ids(folder)));
    }
    let path = session_path(folder, file)?;
    write_atomic(&path, &serde_json::to_string_pretty(&session)?)
}

/// The session map: a page-by-page index of the folder that goes into every prompt, so the model
/// knows what else is in the session even when the pages themselves did not fit the budget.
/// `map.json` holds the one-line summaries and the fingerprint of the text each was written for;
/// `map.md` is the same thing rendered, kept beside it so it can be read without the app.
pub fn load_map(folder: &str) -> Result<Option<Value>> {
    let path = reader_dir(folder).join("map.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

pub fn save_map(folder: &str, cache: &Value, rendered: &str) -> Result<()> {
    let dir = reader_dir(folder);
    write_atomic(&dir.join("map.json"), &serde_json::to_string_pretty(cache)?)?;
    write_atomic(&dir.join("map.md"), rendered)
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
    } else if p.is_file() && is_openable_page(p) {
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

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn is_html(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
        .unwrap_or(false)
}

fn is_openable_page(path: &Path) -> bool {
    is_markdown(path) || is_pdf(path) || is_html(path)
}

/// Extract text content from a PDF file using the pdf-extract crate.
/// This handles compressed PDFs and properly extracts text from content streams.
fn extract_pdf_text(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    
    match pdf_extract::extract_text_from_mem(&bytes) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // PDF exists but has no extractable text (e.g., scanned image-only PDF)
                Err(AppError::Message(format!(
                    "PDF file '{}' contains no extractable text (possibly a scanned document)",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("document")
                )))
            } else {
                Ok(text)
            }
        }
        Err(_e) => {
            // pdf-extract failed, try naive BT/ET fallback for simple test PDFs
            let text = extract_pdf_text_naive(&bytes);
            if text.trim().is_empty() {
                Err(AppError::Message(format!(
                    "Failed to extract text from PDF '{}'",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("document")
                )))
            } else {
                Ok(text)
            }
        }
    }
}

/// Naive PDF text extraction for simple hand-crafted test PDFs.
/// Scans for BT/ET operators and (text) Tj commands in uncompressed streams.
/// This is a fallback only; real PDFs should use pdf-extract.
fn extract_pdf_text_naive(bytes: &[u8]) -> String {
    let content = String::from_utf8_lossy(bytes);
    let mut text = String::new();
    let mut in_text = false;
    
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "BT" {
            in_text = true;
        } else if trimmed == "ET" {
            in_text = false;
            text.push('\n');
        } else if in_text {
            // Look for text in parentheses: (text) Tj
            if let Some(start) = trimmed.find('(') {
                if let Some(end) = trimmed[start..].find(')') {
                    let extracted = &trimmed[start + 1..start + end];
                    text.push_str(extracted);
                    text.push(' ');
                }
            }
        }
    }
    
    text
}

/// Extract text content from an HTML file.
/// Simple HTML-to-text conversion that strips tags and decodes entities.
fn extract_html_text(path: &Path) -> Result<String> {
    let html = fs::read_to_string(path)?;
    
    // Remove script and style tags and their content
    let mut cleaned = html.clone();
    while let Some(start) = cleaned.find("<script") {
        if let Some(end) = cleaned[start..].find("</script>") {
            cleaned.replace_range(start..start + end + 9, "");
        } else {
            break;
        }
    }
    while let Some(start) = cleaned.find("<style") {
        if let Some(end) = cleaned[start..].find("</style>") {
            cleaned.replace_range(start..start + end + 8, "");
        } else {
            break;
        }
    }
    
    // Replace HTML tags with spaces
    let mut result = String::new();
    let mut in_tag = false;
    for c in cleaned.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    
    // Decode common HTML entities
    result = result
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    
    // Normalize whitespace
    let text: String = result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    
    Ok(text)
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

/// Unix `dev:ino` for a path, so a Finder rename of the same file can be matched later.
/// Cross-volume copies get a new inode and are treated as a new file.
pub fn path_id(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(path).ok()?;
        Some(format!("{}:{}", m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Relative page path → `dev:ino` for every Markdown file in the folder, same walk as `list_pages`.
pub fn collect_ids(folder: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let root = Path::new(folder);
    if !root.is_dir() {
        return out;
    }
    for_each_markdown(root, |path, rel| {
        if let Some(id) = path_id(path) {
            out.insert(rel.to_string(), id);
        }
    });
    out
}

/// If `file` is missing, match Markdown in the folder by stored `dev:ino`. When a relative
/// path remaps, rename `.reader/session-<old>.json` and `versions/<old_key>/` if the
/// destination is free, and rewrite trail/current/unread/pending/`source` in the same pass.
///
/// On Mac, `bookmark` is tried first when the absolute folder path is gone. There is no
/// full-volume search if both the path and the bookmark fail.
pub fn resolve_session(
    folder: &str,
    file: Option<&str>,
    ids: Option<&HashMap<String, String>>,
    bookmark: Option<&str>,
) -> Result<ResolvedSession> {
    let file = file.filter(|s| !s.is_empty());
    let mut folder = folder.to_string();
    if !Path::new(&folder).is_dir() {
        if let Some(resolved) = bookmark.and_then(resolve_bookmark) {
            if Path::new(&resolved).is_dir() {
                folder = resolved;
            }
        }
    }

    let bookmark_out = folder_bookmark(&folder).or_else(|| bookmark.map(str::to_string));
    let folder_id = path_id(Path::new(&folder));

    if !Path::new(&folder).is_dir() {
        return Ok(ResolvedSession {
            folder,
            file: file.map(str::to_string),
            remaps: vec![],
            folder_id,
            file_id: None,
            bookmark: bookmark_out,
        });
    }

    let remaps = find_remaps(&folder, file, ids);
    let new_file = file.map(|f| apply_one(f, &remaps));
    if !remaps.is_empty() {
        relocate_reader_dirs(&folder, &remaps)?;
        rewrite_session_keys(&folder, file, &new_file, &remaps)?;
        rewrite_source_keys(&folder, &remaps);
    }

    let file_id = new_file.as_ref().and_then(|rel| path_id(&Path::new(&folder).join(rel)));
    Ok(ResolvedSession {
        folder,
        file: new_file,
        remaps,
        folder_id,
        file_id,
        bookmark: bookmark_out,
    })
}

fn for_each_markdown(root: &Path, mut f: impl FnMut(&Path, &str)) {
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
        f(path, &rel);
    }
}

fn index_by_id(folder: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for_each_markdown(Path::new(folder), |path, rel| {
        if let Some(id) = path_id(path) {
            out.entry(id).or_insert_with(|| rel.to_string());
        }
    });
    out
}

fn merge_ids(folder: &str, file: Option<&str>, passed: Option<&HashMap<String, String>>) -> HashMap<String, String> {
    let mut ids = HashMap::new();
    if let Ok(Some(stored)) = load_session(folder, file) {
        if let Some(obj) = stored.get("ids").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let Some(id) = v.as_str() {
                    ids.insert(k.clone(), id.to_string());
                }
            }
        }
    }
    if let Some(passed) = passed {
        for (k, v) in passed {
            ids.insert(k.clone(), v.clone());
        }
    }
    ids
}

fn find_remaps(folder: &str, file: Option<&str>, passed: Option<&HashMap<String, String>>) -> Vec<(String, String)> {
    let ids = merge_ids(folder, file, passed);
    if ids.is_empty() {
        return vec![];
    }
    let by_id = index_by_id(folder);
    let mut remaps = Vec::new();
    let mut taken = std::collections::HashSet::new();
    for (old, id) in &ids {
        let Ok(full) = safe_join(folder, old) else { continue };
        if path_id(&full).as_deref() == Some(id.as_str()) {
            continue;
        }
        let Some(new_rel) = by_id.get(id) else { continue };
        if new_rel == old || taken.contains(new_rel) {
            continue;
        }
        taken.insert(new_rel.clone());
        remaps.push((old.clone(), new_rel.clone()));
    }
    remaps.sort_by(|a, b| a.0.cmp(&b.0));
    remaps
}

fn apply_one(path: &str, remaps: &[(String, String)]) -> String {
    remaps.iter().find(|(from, _)| from == path).map(|(_, to)| to.clone()).unwrap_or_else(|| path.to_string())
}

fn remap_table(remaps: &[(String, String)]) -> HashMap<String, String> {
    remaps.iter().cloned().collect()
}

/// Rename `.reader/session-<page>.json` and `versions/<page_key>/` for each remap whose destination is free.
fn relocate_reader_dirs(folder: &str, remaps: &[(String, String)]) -> Result<()> {
    for (from, to) in remaps {
        let from_session = session_path(folder, Some(from))?;
        let to_session = session_path(folder, Some(to))?;
        relocate_if_free(&from_session, &to_session);
        let from_versions = versions_dir(folder, from)?;
        let to_versions = versions_dir(folder, to)?;
        relocate_if_free(&from_versions, &to_versions);
    }
    Ok(())
}

fn relocate_if_free(from: &Path, to: &Path) {
    if from == to || !from.exists() || to.exists() {
        return;
    }
    if let Some(parent) = to.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::rename(from, to);
}

fn rewrite_session_keys(folder: &str, old_file: Option<&str>, new_file: &Option<String>, remaps: &[(String, String)]) -> Result<()> {
    let table = remap_table(remaps);
    let src = session_path(folder, old_file)?;
    let dest = session_path(folder, new_file.as_deref())?;
    let mut session = if src.exists() {
        serde_json::from_str(&fs::read_to_string(&src)?)?
    } else if dest.exists() && dest != src {
        serde_json::from_str(&fs::read_to_string(&dest)?)?
    } else {
        return Ok(());
    };
    remap_session_value(&mut session, folder, &table);
    if let Some(obj) = session.as_object_mut() {
        obj.insert("ids".into(), json!(collect_ids(folder)));
    }

    if src != dest && dest.exists() && src.exists() {
        // Another session already lives at the new name; keep the rewritten state on the old file.
        write_atomic(&src, &serde_json::to_string_pretty(&session)?)?;
        return Ok(());
    }
    if src != dest && src.exists() && !dest.exists() {
        relocate_if_free(&src, &dest);
    }
    write_atomic(&dest, &serde_json::to_string_pretty(&session)?)?;
    if src != dest && src.exists() {
        let _ = fs::remove_file(&src);
    }
    Ok(())
}

fn remap_session_value(session: &mut Value, folder: &str, remaps: &HashMap<String, String>) {
    let Some(obj) = session.as_object_mut() else { return };
    for key in ["current", "split"] {
        remap_string_field(obj, key, remaps);
    }
    for key in ["trail", "unread", "loading"] {
        remap_string_list(obj, key, remaps);
    }
    for key in ["read", "pending", "asks", "ids"] {
        remap_object_keys(obj, key, remaps);
    }
    if let Some(Value::Array(roots)) = obj.get_mut("roots") {
        for root in roots {
            let Some(root_obj) = root.as_object_mut() else { continue };
            let same_folder = root_obj.get("folder").and_then(|v| v.as_str()) == Some(folder);
            if same_folder {
                remap_string_field(root_obj, "file", remaps);
            }
        }
    }
}

fn remap_string_field(obj: &mut Map<String, Value>, key: &str, remaps: &HashMap<String, String>) {
    let Some(Value::String(s)) = obj.get(key) else { return };
    if let Some(to) = remaps.get(s) {
        obj.insert(key.to_string(), json!(to));
    }
}

fn remap_string_list(obj: &mut Map<String, Value>, key: &str, remaps: &HashMap<String, String>) {
    let Some(Value::Array(arr)) = obj.get_mut(key) else { return };
    for item in arr {
        let Some(s) = item.as_str() else { continue };
        if let Some(to) = remaps.get(s) {
            *item = json!(to);
        }
    }
}

fn remap_object_keys(obj: &mut Map<String, Value>, key: &str, remaps: &HashMap<String, String>) {
    let Some(Value::Object(map)) = obj.get_mut(key) else { return };
    let old = std::mem::take(map);
    for (k, v) in old {
        map.insert(remaps.get(&k).cloned().unwrap_or(k), v);
    }
}

/// Pages that still name a remapped path as `source` follow it, so a file session keeps its grown pages.
fn rewrite_source_keys(folder: &str, remaps: &[(String, String)]) {
    if remaps.is_empty() {
        return;
    }
    let table = remap_table(remaps);
    let root = Path::new(folder);
    let mut files = Vec::new();
    for_each_markdown(root, |path, _| files.push(path.to_path_buf()));
    for path in files {
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        let Some(next) = remap_source_in_raw(&raw, &table) else { continue };
        let _ = write_atomic(&path, &next);
    }
}

fn remap_source_in_raw(raw: &str, remaps: &HashMap<String, String>) -> Option<String> {
    if !raw.starts_with("---") {
        return None;
    }
    let mut out = String::new();
    let mut in_fm = false;
    let mut seen_open = false;
    let mut changed = false;
    for line in raw.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !seen_open {
            seen_open = trimmed == "---";
            in_fm = seen_open;
            out.push_str(line);
            continue;
        }
        if in_fm && trimmed == "---" {
            in_fm = false;
            out.push_str(line);
            continue;
        }
        if in_fm {
            if let Some(value) = trimmed.strip_prefix("source:") {
                let unquoted = unquote_yaml(value.trim());
                if let Some(to) = remaps.get(&unquoted) {
                    out.push_str("source: ");
                    out.push_str(&yaml_scalar(to));
                    if line.ends_with('\n') {
                        out.push('\n');
                    }
                    changed = true;
                    continue;
                }
            }
        }
        out.push_str(line);
    }
    changed.then_some(out)
}

fn unquote_yaml(s: &str) -> String {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return serde_json::from_str(s).unwrap_or_else(|_| s[1..s.len() - 1].to_string());
    }
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return s[1..s.len() - 1].replace("''", "'");
    }
    s.to_string()
}

fn yaml_scalar(s: &str) -> String {
    if s.is_empty() || s.trim() != s || s.contains([':', '#', '"', '\'', '\n']) {
        serde_json::to_string(s).unwrap_or_else(|_| s.to_string())
    } else {
        s.to_string()
    }
}

/// A Mac NSURL bookmark for the folder, so a rename of the folder itself can still be opened.
/// Other platforms have nothing equivalent; they store only the path and inode.
pub fn folder_bookmark(folder: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        bookmark::create(folder)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = folder;
        None
    }
}

fn resolve_bookmark(bookmark: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        bookmark::resolve(bookmark)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bookmark;
        None
    }
}

#[cfg(target_os = "macos")]
mod bookmark {
    use objc2::rc::RetainedFromIterator;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions};

    pub fn create(folder: &str) -> Option<String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(folder));
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::MinimalBookmark,
                None,
                None,
            )
            .ok()?;
        Some(b64_encode(&nsdata_bytes(&data)))
    }

    pub fn resolve(bookmark: &str) -> Option<String> {
        let bytes = b64_decode(bookmark)?;
        let data = NSData::retained_from_iter(bytes);
        let mut stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithoutUI,
                None,
                &mut stale,
            )
        }
        .ok()?;
        url.path().map(|p| p.to_string())
    }

    fn nsdata_bytes(data: &NSData) -> Vec<u8> {
        data.to_vec()
    }

    fn b64_encode(input: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        let mut i = 0;
        while i < input.len() {
            let b0 = input[i];
            let b1 = input.get(i + 1).copied().unwrap_or(0);
            let b2 = input.get(i + 2).copied().unwrap_or(0);
            out.push(T[(b0 >> 2) as usize] as char);
            out.push(T[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
            out.push(if i + 1 < input.len() { T[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
            out.push(if i + 2 < input.len() { T[(b2 & 63) as usize] as char } else { '=' });
            i += 3;
        }
        out
    }

    fn b64_decode(s: &str) -> Option<Vec<u8>> {
        fn val(c: u8) -> Option<u8> {
            Some(match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => 0,
                _ => return None,
            })
        }
        let bytes = s.as_bytes();
        if bytes.len() % 4 != 0 {
            return None;
        }
        let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
        for chunk in bytes.chunks(4) {
            let a = val(chunk[0])?;
            let b = val(chunk[1])?;
            let c = val(chunk[2])?;
            let d = val(chunk[3])?;
            out.push((a << 2) | (b >> 4));
            if chunk[2] != b'=' {
                out.push((b << 4) | (c >> 2));
            }
            if chunk[3] != b'=' {
                out.push((c << 6) | d);
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_md(dir: &Path, name: &str, body: &str) {
        if let Some(parent) = dir.join(name).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn save_session_records_file_ids() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# A\n");
        let folder = dir.path().to_str().unwrap();
        save_session(folder, &json!({ "trail": ["a.md"], "trailIndex": 0 }), None).unwrap();
        let stored = load_session(folder, None).unwrap().unwrap();
        let id = path_id(&dir.path().join("a.md")).expect("unix inode");
        assert_eq!(stored["ids"]["a.md"], id);
    }

    #[test]
    fn resolve_session_follows_a_renamed_page() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# A\n");
        let folder = dir.path().to_str().unwrap();
        let id = path_id(&dir.path().join("a.md")).expect("unix inode");
        fs::create_dir_all(dir.path().join(".reader/versions/a")).unwrap();
        fs::write(
            dir.path().join(".reader/session-a.json"),
            serde_json::to_string(&json!({
                "current": "a.md",
                "trail": ["a.md"],
                "trailIndex": 0,
                "unread": ["a.md"],
                "pending": { "a.md": 1 },
                "ids": { "a.md": id },
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(dir.path().join(".reader/versions/a/v1.md"), "old\n").unwrap();

        fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();

        let mut ids = HashMap::new();
        ids.insert("a.md".into(), id.clone());
        let resolved = resolve_session(folder, Some("a.md"), Some(&ids), None).unwrap();
        assert_eq!(resolved.file.as_deref(), Some("b.md"));
        assert_eq!(resolved.remaps, vec![("a.md".into(), "b.md".into())]);
        assert_eq!(resolved.file_id.as_deref(), Some(id.as_str()));
        assert!(dir.path().join("b.md").is_file());
        assert!(dir.path().join(".reader/session-b.json").is_file());
        assert!(!dir.path().join(".reader/session-a.json").exists());
        assert!(dir.path().join(".reader/versions/b/v1.md").is_file());
        assert!(!dir.path().join(".reader/versions/a").exists());

        let session = load_session(folder, Some("b.md")).unwrap().unwrap();
        assert_eq!(session["current"], "b.md");
        assert_eq!(session["trail"][0], "b.md");
        assert_eq!(session["unread"][0], "b.md");
        assert_eq!(session["pending"]["b.md"], 1);
        assert_eq!(session["ids"]["b.md"], id);
        assert!(session["ids"].get("a.md").is_none());
    }

    #[test]
    fn resolve_session_rewrites_source_in_a_folder_session() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# A\n");
        write_md(dir.path(), "child.md", "---\nsource: a.md\n---\n\n# Child\n");
        let folder = dir.path().to_str().unwrap();
        let id = path_id(&dir.path().join("a.md")).expect("unix inode");
        save_session(
            folder,
            &json!({
                "current": "a.md",
                "trail": ["a.md", "child.md"],
                "trailIndex": 1,
            }),
            None,
        )
        .unwrap();

        fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();

        let mut ids = HashMap::new();
        ids.insert("a.md".into(), id);
        let resolved = resolve_session(folder, None, Some(&ids), None).unwrap();
        assert_eq!(resolved.file, None);
        assert_eq!(resolved.remaps, vec![("a.md".into(), "b.md".into())]);

        let session = load_session(folder, None).unwrap().unwrap();
        assert_eq!(session["current"], "b.md");
        assert_eq!(session["trail"][0], "b.md");
        assert_eq!(session["trail"][1], "child.md");
        let child = fs::read_to_string(dir.path().join("child.md")).unwrap();
        assert!(child.contains("source: b.md"), "{child}");
        assert!(!child.contains("source: a.md"), "{child}");
    }

    #[test]
    fn resolve_session_leaves_a_missing_file_without_an_id() {
        let dir = folder();
        write_md(dir.path(), "kept.md", "# Kept\n");
        let folder = dir.path().to_str().unwrap();
        let resolved = resolve_session(folder, Some("gone.md"), None, None).unwrap();
        assert_eq!(resolved.file.as_deref(), Some("gone.md"));
        assert!(resolved.remaps.is_empty());
    }

    #[test]
    fn resolve_session_skips_version_dir_when_destination_exists() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# A\n");
        let folder = dir.path().to_str().unwrap();
        let id = path_id(&dir.path().join("a.md")).expect("unix inode");
        fs::create_dir_all(dir.path().join(".reader/versions/a")).unwrap();
        fs::create_dir_all(dir.path().join(".reader/versions/b")).unwrap();
        fs::write(dir.path().join(".reader/versions/a/v1.md"), "from-a\n").unwrap();
        fs::write(dir.path().join(".reader/versions/b/v1.md"), "from-b\n").unwrap();
        fs::write(
            dir.path().join(".reader/session.json"),
            serde_json::to_string(&json!({ "current": "a.md", "ids": { "a.md": id } })).unwrap(),
        )
        .unwrap();

        fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();
        let mut ids = HashMap::new();
        ids.insert("a.md".into(), id);
        let resolved = resolve_session(folder, None, Some(&ids), None).unwrap();
        assert_eq!(resolved.remaps, vec![("a.md".into(), "b.md".into())]);
        assert_eq!(fs::read_to_string(dir.path().join(".reader/versions/a/v1.md")).unwrap(), "from-a\n");
        assert_eq!(fs::read_to_string(dir.path().join(".reader/versions/b/v1.md")).unwrap(), "from-b\n");
    }

    #[test]
    fn nested_pdf_fixture_extracted() {
        // This test uses the fixture at .unlazy/fixtures/sample.pdf
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".unlazy/fixtures/sample.pdf");
        
        if !fixture_path.exists() {
            panic!("Fixture not found: {:?}", fixture_path);
        }
        
        let text = extract_pdf_text(&fixture_path).unwrap();
        println!("Extracted PDF text: {}", text);
        assert!(text.contains("Nested PDF Fixture"), 
            "Expected 'Nested PDF Fixture' in extracted text, got: {}", text);
    }

    #[test]
    fn nested_html_fixture_extracted() {
        // This test uses the fixture at .unlazy/fixtures/sample.html
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".unlazy/fixtures/sample.html");
        
        if !fixture_path.exists() {
            panic!("Fixture not found: {:?}", fixture_path);
        }
        
        let text = extract_html_text(&fixture_path).unwrap();
        println!("Extracted HTML text: {}", text);
        assert!(text.contains("Nested HTML Fixture"),
            "Expected 'Nested HTML Fixture' in extracted text, got: {}", text);
    }

    #[test]
    fn list_pages_includes_pdf_files() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# Markdown\n");
        
        // Copy the test fixture PDF
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".unlazy/fixtures/sample.pdf");
        fs::copy(&fixture_path, dir.path().join("test.pdf")).unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let pages = list_pages(folder).unwrap();
        assert_eq!(pages.len(), 2);
        let paths: Vec<&str> = pages.iter().map(|p| p.path.as_str()).collect();
        assert!(paths.contains(&"a.md"));
        assert!(paths.contains(&"test.pdf"));
    }

    #[test]
    fn list_pages_includes_html_files() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# Markdown\n");
        fs::write(
            dir.path().join("test.html"),
            "<html><body><h1>Test HTML</h1><p>Content here.</p></body></html>"
        ).unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let pages = list_pages(folder).unwrap();
        assert_eq!(pages.len(), 2);
        let paths: Vec<&str> = pages.iter().map(|p| p.path.as_str()).collect();
        assert!(paths.contains(&"a.md"));
        assert!(paths.contains(&"test.html"));
    }

    #[test]
    fn read_pdf_extracts_text() {
        let dir = folder();
        
        // Copy the test fixture PDF
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".unlazy/fixtures/sample.pdf");
        fs::copy(&fixture_path, dir.path().join("sample.pdf")).unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let page = read_page(folder, "sample.pdf").unwrap();
        assert_eq!(page.path, "sample.pdf");
        assert!(page.raw.contains("Nested PDF Fixture"));
    }

    #[test]
    fn read_html_extracts_text() {
        let dir = folder();
        fs::write(
            dir.path().join("sample.html"),
            "<html><head><title>Test</title></head><body><h1>Welcome</h1><p>This is a test.</p></body></html>"
        ).unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let page = read_page(folder, "sample.html").unwrap();
        assert_eq!(page.path, "sample.html");
        assert!(page.raw.contains("Welcome"));
        assert!(page.raw.contains("test"));
    }

    #[test]
    fn write_page_rejects_pdf() {
        let dir = folder();
        fs::write(dir.path().join("test.pdf"), b"fake pdf").unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let result = write_page(folder, "test.pdf", "new content");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("read-only"));
    }

    #[test]
    fn write_page_rejects_html() {
        let dir = folder();
        fs::write(dir.path().join("test.html"), "<html></html>").unwrap();
        
        let folder = dir.path().to_str().unwrap();
        let result = write_page(folder, "test.html", "new content");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("read-only"));
    }

    #[test]
    fn path_kind_recognizes_pdf() {
        let dir = folder();
        fs::write(dir.path().join("test.pdf"), b"fake").unwrap();
        assert_eq!(path_kind(dir.path().join("test.pdf").to_str().unwrap()), "file");
    }

    #[test]
    fn path_kind_recognizes_html() {
        let dir = folder();
        fs::write(dir.path().join("test.html"), "html").unwrap();
        assert_eq!(path_kind(dir.path().join("test.html").to_str().unwrap()), "file");
        
        fs::write(dir.path().join("test.htm"), "htm").unwrap();
        assert_eq!(path_kind(dir.path().join("test.htm").to_str().unwrap()), "file");
    }
}
