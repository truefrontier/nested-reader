//! The tools a model may call while it answers: list, read and search the pages of the
//! session folder, and of any folder added to the session with ⌘⇧O. They are read-only and
//! never reach outside those folders.

use crate::files;
use serde_json::{json, Value};

/// How many rounds of tool calls one request may take before the answer must come.
pub const MAX_ROUNDS: usize = 8;
const MAX_PAGE_CHARS: usize = 40_000;
const MAX_HITS: usize = 60;
const MAX_LINE_CHARS: usize = 240;

/// A tool as the providers all describe it: a name, what it does, and a JSON Schema for its input.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_pages",
            description: "List every Markdown page in the session: its path and title, one per line. Pages of a folder added to the session are listed by their full path.",
            schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolDef {
            name: "read_page",
            description: "Read one page of the session in full. Give its path exactly as listed by list_pages.",
            schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Page path as listed, e.g. notes/replay.md" } },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolDef {
            name: "search_pages",
            description: "Find lines across every page in the session that contain the query, case-insensitively. Returns path, line number and the line.",
            schema: json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Words to look for" } },
                "required": ["query"],
                "additionalProperties": false
            }),
        },
    ]
}

/// The list in Anthropic's shape: `name`, `description`, `input_schema`.
pub fn anthropic_tools() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
        .collect()
}

/// The list in the OpenAI shape, which Ollama shares: `{ type: "function", function: { … } }`.
pub fn openai_tools() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
        .collect()
}

/// What a tool returned: the text for the model, and whether it counts as an error.
pub struct Outcome {
    pub text: String,
    pub is_error: bool,
}

/// A short line for the UI: what the model is doing with this call.
pub fn describe(name: &str, input: &Value) -> String {
    match name {
        "list_pages" => "Listing the pages".to_string(),
        "read_page" => {
            let path = input["path"].as_str().unwrap_or("");
            let base = path.rsplit('/').next().unwrap_or(path);
            if base.is_empty() {
                "Reading a page".to_string()
            } else {
                format!("Reading {base}")
            }
        }
        "search_pages" => {
            let q = input["query"].as_str().unwrap_or("").trim();
            if q.is_empty() {
                "Searching the pages".to_string()
            } else {
                format!("Searching for “{}”", clip(q, 40))
            }
        }
        other => format!("Using {other}"),
    }
}

/// Runs one tool against the session folder and the added `roots`. Failures come back as text for the model, not as errors.
pub fn run(folder: &str, roots: &[String], name: &str, input: &Value) -> Outcome {
    let result = match name {
        "list_pages" => list_pages(folder, roots),
        "read_page" => read_page(folder, roots, input["path"].as_str().unwrap_or("")),
        "search_pages" => search_pages(folder, roots, input["query"].as_str().unwrap_or("")),
        other => Err(format!("Unknown tool: {other}")),
    };
    match result {
        Ok(text) => Outcome { text, is_error: false },
        Err(text) => Outcome { text, is_error: true },
    }
}

/// Every page of the session: the folder's by their path inside it, each added root's by full path.
fn all_pages(folder: &str, roots: &[String]) -> Result<Vec<files::RawPage>, String> {
    let mut out = files::list_pages(folder).map_err(|e| e.to_string())?;
    for root in roots {
        // A root that cannot be read any more just contributes nothing.
        let Ok(pages) = files::list_pages(root) else { continue };
        out.extend(pages.into_iter().map(|p| files::RawPage { path: format!("{root}/{}", p.path), ..p }));
    }
    Ok(out)
}

/// The root a listed path belongs to, with the path inside it; the session folder when it is none of the roots.
fn locate<'a>(folder: &'a str, roots: &'a [String], path: &'a str) -> (&'a str, &'a str) {
    let mut best: Option<&str> = None;
    for root in roots {
        let under = path.strip_prefix(root.as_str()).is_some_and(|rest| rest.starts_with('/'));
        if under && best.is_none_or(|b| root.len() > b.len()) {
            best = Some(root);
        }
    }
    match best {
        Some(root) => (root, &path[root.len() + 1..]),
        None => (folder, path),
    }
}

fn list_pages(folder: &str, roots: &[String]) -> Result<String, String> {
    let pages = all_pages(folder, roots)?;
    if pages.is_empty() {
        return Ok("The session has no pages.".to_string());
    }
    let mut lines: Vec<String> = pages.iter().map(|p| format!("{} — {}", p.path, title_of(&p.raw, &p.path))).collect();
    lines.sort();
    Ok(lines.join("\n"))
}

fn read_page(folder: &str, roots: &[String], path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Give the page's path, as listed by list_pages.".to_string());
    }
    if !path.ends_with(".md") {
        return Err(format!("Only Markdown pages can be read; {path} is not one."));
    }
    let (root, rel) = locate(folder, roots, path);
    // Hidden directories hold the reader's own state (old versions, session files), not pages.
    if rel.split('/').any(|part| part.starts_with('.')) {
        return Err(format!("{path} is not a page of the session."));
    }
    let page = files::read_page(root, rel).map_err(|e| e.to_string())?;
    if page.raw.chars().count() > MAX_PAGE_CHARS {
        let head: String = page.raw.chars().take(MAX_PAGE_CHARS).collect();
        return Ok(format!("{head}\n\n[The page goes on; only the first {MAX_PAGE_CHARS} characters are shown.]"));
    }
    Ok(page.raw)
}

fn search_pages(folder: &str, roots: &[String], query: &str) -> Result<String, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("Give some words to search for.".to_string());
    }
    let pages = all_pages(folder, roots)?;
    let mut hits: Vec<String> = Vec::new();
    let mut total = 0usize;
    for p in &pages {
        for (i, line) in p.raw.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                total += 1;
                if hits.len() < MAX_HITS {
                    hits.push(format!("{}:{}: {}", p.path, i + 1, clip(line.trim(), MAX_LINE_CHARS)));
                }
            }
        }
    }
    if hits.is_empty() {
        return Ok(format!("No page mentions “{}”.", query.trim()));
    }
    let mut out = hits.join("\n");
    if total > hits.len() {
        out.push_str(&format!("\n\n[{} more matching lines not shown; narrow the query.]", total - hits.len()));
    }
    Ok(out)
}

/// The page's title: `title:` in its front matter, else its first heading, else its file name.
fn title_of(raw: &str, path: &str) -> String {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) == Some("---") {
        for line in lines.by_ref() {
            let t = line.trim();
            if t == "---" {
                break;
            }
            if let Some(v) = t.strip_prefix("title:") {
                let v = v.trim();
                // A quoted title was written as a JSON string.
                let v = serde_json::from_str::<String>(v).unwrap_or_else(|_| v.to_string());
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }
    for line in raw.lines() {
        if let Some(h) = line.trim().strip_prefix("# ") {
            let h = h.trim();
            if !h.is_empty() {
                return h.to_string();
            }
        }
    }
    path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md").to_string()
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("replay.md"), "---\ntitle: Replay into cortex\n---\n\n# Replay\n\nRipples carry the sequence.\n").unwrap();
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/sleep.md"), "# Sleep stages\n\nA ripple happens in slow-wave sleep.\n").unwrap();
        std::fs::create_dir(dir.path().join(".reader")).unwrap();
        std::fs::write(dir.path().join(".reader/session.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn lists_pages_with_titles() {
        let dir = folder();
        let out = run(dir.path().to_str().unwrap(), &[], "list_pages", &json!({}));
        assert!(!out.is_error);
        assert_eq!(out.text, "notes/sleep.md — Sleep stages\nreplay.md — Replay into cortex");
    }

    #[test]
    fn added_roots_are_listed_read_and_searched_by_full_path() {
        let dir = folder();
        let extra = tempfile::tempdir().unwrap();
        std::fs::write(extra.path().join("cues.md"), "# Odour cues\n\nA rose scent during sleep.\n").unwrap();
        let f = dir.path().to_str().unwrap();
        let roots = vec![extra.path().to_str().unwrap().to_string()];
        let cues = format!("{}/cues.md", roots[0]);
        let out = run(f, &roots, "list_pages", &json!({}));
        assert!(out.text.contains(&format!("{cues} — Odour cues")), "{}", out.text);
        assert!(out.text.contains("replay.md — Replay into cortex"), "{}", out.text);
        let out = run(f, &roots, "read_page", &json!({ "path": cues }));
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.starts_with("# Odour cues"));
        let out = run(f, &roots, "search_pages", &json!({ "query": "rose" }));
        assert!(out.text.contains(&format!("{cues}:3: A rose scent during sleep.")), "{}", out.text);
        // A root's own hidden state stays out of reach, and a path outside every root is refused.
        let out = run(f, &roots, "read_page", &json!({ "path": format!("{}/.reader/session.json", roots[0]) }));
        assert!(out.is_error);
        let out = run(f, &roots, "read_page", &json!({ "path": format!("{}/../outside.md", roots[0]) }));
        assert!(out.is_error);
    }

    #[test]
    fn reads_a_page_and_refuses_to_leave_the_folder() {
        let dir = folder();
        let f = dir.path().to_str().unwrap();
        let out = run(f, &[], "read_page", &json!({ "path": "notes/sleep.md" }));
        assert!(!out.is_error);
        assert!(out.text.starts_with("# Sleep stages"));
        let out = run(f, &[], "read_page", &json!({ "path": "../secret.md" }));
        assert!(out.is_error);
        let out = run(f, &[], "read_page", &json!({ "path": ".reader/session.json" }));
        assert!(out.is_error);
        let out = run(f, &[], "read_page", &json!({ "path": ".reader/versions/replay/v1.md" }));
        assert!(out.is_error);
    }

    #[test]
    fn searches_case_insensitively() {
        let dir = folder();
        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "RIPPLE" }));
        assert!(!out.is_error);
        assert!(out.text.contains("replay.md:7: Ripples carry the sequence."), "{}", out.text);
        assert!(out.text.contains("notes/sleep.md:3: A ripple happens in slow-wave sleep."), "{}", out.text);
        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "giraffe" }));
        assert_eq!(out.text, "No page mentions “giraffe”.");
    }

    #[test]
    fn describes_calls_for_the_ui() {
        assert_eq!(describe("read_page", &json!({ "path": "notes/sleep.md" })), "Reading sleep.md");
        assert_eq!(describe("search_pages", &json!({ "query": "ripple" })), "Searching for “ripple”");
        assert_eq!(describe("list_pages", &json!({})), "Listing the pages");
    }
}
