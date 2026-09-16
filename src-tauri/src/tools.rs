//! The tools a model may call while it answers: list, read and search the pages of the
//! session folder, and of any folder added to the session with ⌘⇧O. They are read-only and
//! never reach outside those folders.

use crate::files;
use serde_json::{json, Value};
use std::collections::HashSet;

/// How many rounds of tool calls one request may take before the answer must come.
pub const MAX_ROUNDS: usize = 8;
const MAX_PAGE_CHARS: usize = 40_000;
const MAX_HITS: usize = 60;
const MAX_LINE_CHARS: usize = 240;
/// How many lines one page may contribute before the other pages get their turn, so a single
/// chatty page cannot take the whole answer.
const PER_PAGE_HITS: usize = 6;

/// Words too common to say anything about which page is wanted. Kept in step with `STOP` in
/// `src/lib/rank.ts`, which picks the prompt's context pages by the same measure; the two have to
/// agree on what a word is or the folder the model searches and the folder it is shown disagree.
const STOP: &[&str] = &[
    "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because", "been",
    "before", "being", "between", "both", "but", "by", "can", "did", "do", "does", "doing", "down", "during",
    "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "him",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "more", "most", "my", "no", "nor",
    "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "out", "over", "own", "same",
    "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "then", "there",
    "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "we",
    "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you",
    "your", "yours",
];

/// Saturation point for term frequency: past this, saying it again barely counts.
const K1: f64 = 1.2;
/// How hard to penalise a long page. Milder than the usual 0.75 because a long note is usually
/// thorough rather than padded, and a stub should not win on brevity alone.
const B: f64 = 0.3;
/// A query word in the title says more than the same word in the body, in proportion to its rarity.
const TITLE_WEIGHT: f64 = 1.0;

/// Folds a plural onto its singular, so searching for "ripple" ranks the page about ripples.
/// Only plurals: -s and -ies are the endings that keep notes from matching, and stripping more
/// (-ing, -ed) starts changing words that meant different things. Mirrored in `src/lib/rank.ts`.
fn stem(w: &str) -> String {
    let n = w.chars().count();
    if n > 4 && w.ends_with("sses") {
        return w[..w.len() - 2].to_string();
    }
    if n > 4 && w.ends_with("ies") {
        return format!("{}y", &w[..w.len() - 3]);
    }
    if w.ends_with("ss") {
        return w.to_string();
    }
    if n > 3 && w.ends_with('s') {
        return w[..w.len() - 1].to_string();
    }
    w.to_string()
}

/// The words of a piece of text, counted as `words()` in `src/lib/rank.ts` counts them.
fn words(text: &str, stop: &HashSet<&str>) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2 && !stop.contains(w))
        .map(stem)
        .collect()
}

/// BM25 per page over the query's words, with a title match worth whatever that word is rare.
fn relevance(terms: &[String], bodies: &[Vec<String>], titles: &[HashSet<String>]) -> Vec<f64> {
    let total = bodies.len();
    if total == 0 {
        return Vec::new();
    }
    let avg_len = bodies.iter().map(|d| d.len()).sum::<usize>() as f64 / total as f64;
    let avg_len = if avg_len > 0.0 { avg_len } else { 1.0 };

    let counts: Vec<std::collections::HashMap<&str, usize>> = bodies
        .iter()
        .map(|d| {
            let mut tf = std::collections::HashMap::new();
            for w in d {
                *tf.entry(w.as_str()).or_insert(0) += 1;
            }
            tf
        })
        .collect();

    (0..total)
        .map(|i| {
            let mut score = 0.0;
            for t in terms {
                // How many pages the word turns up on at all, which is what makes it rare or common.
                let n = (0..total).filter(|&j| counts[j].contains_key(t.as_str()) || titles[j].contains(t)).count();
                if n == 0 {
                    continue;
                }
                // Lucene's non-negative idf: a word on every page is worth little, never less than nothing.
                let idf = (1.0 + (total as f64 - n as f64 + 0.5) / (n as f64 + 0.5)).ln();
                let tf = *counts[i].get(t.as_str()).unwrap_or(&0) as f64;
                if tf > 0.0 {
                    let norm = 1.0 - B + B * bodies[i].len() as f64 / avg_len;
                    score += idf * (tf * (K1 + 1.0)) / (tf + K1 * norm);
                }
                if titles[i].contains(t) {
                    score += TITLE_WEIGHT * idf;
                }
            }
            score
        })
        .collect()
}

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
    let stop: HashSet<&str> = STOP.iter().copied().collect();
    let mut terms: Vec<String> = Vec::new();
    for w in words(&q, &stop) {
        if !terms.contains(&w) {
            terms.push(w);
        }
    }

    // Lines holding the query as it was typed: the match the reader actually asked for.
    let mut per_page: Vec<Vec<(usize, String)>> = pages
        .iter()
        .map(|p| {
            p.raw
                .lines()
                .enumerate()
                .filter(|(_, l)| l.to_lowercase().contains(&q))
                .map(|(i, l)| (i + 1, l.to_string()))
                .collect()
        })
        .collect();
    // A phrase nobody wrote down word for word would otherwise come back empty, which tells the
    // model nothing it can act on. Falling back to the separate words at least points somewhere.
    let loose = per_page.iter().all(|h| h.is_empty()) && terms.len() > 1;
    if loose {
        per_page = pages
            .iter()
            .map(|p| {
                p.raw
                    .lines()
                    .enumerate()
                    .filter(|(_, l)| {
                        let lower = l.to_lowercase();
                        terms.iter().any(|t| lower.contains(t.as_str()))
                    })
                    .map(|(i, l)| (i + 1, l.to_string()))
                    .collect()
            })
            .collect();
    }
    let total: usize = per_page.iter().map(|h| h.len()).sum();
    if total == 0 {
        return Ok(format!("No page mentions “{}”.", query.trim()));
    }

    // Rank the pages that matched, so the lines that survive the cap come from the pages that
    // discuss the query most rather than from whichever page happened to be read first.
    let bodies: Vec<Vec<String>> = pages.iter().map(|p| words(&p.raw, &stop)).collect();
    let titles: Vec<HashSet<String>> = pages
        .iter()
        .map(|p| words(&title_of(&p.raw, &p.path), &stop).into_iter().collect())
        .collect();
    let scores = relevance(&terms, &bodies, &titles);
    let mut order: Vec<usize> = (0..pages.len()).filter(|&i| !per_page[i].is_empty()).collect();
    order.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            // Ties keep folder order, so equally good pages are never shuffled about.
            .then(a.cmp(&b))
    });

    // A few lines from each page first, best page first, then round again for whatever room is left.
    let mut hits: Vec<String> = Vec::new();
    let mut taken = vec![0usize; pages.len()];
    for cap in [PER_PAGE_HITS, usize::MAX] {
        for &i in &order {
            while taken[i] < cap && taken[i] < per_page[i].len() && hits.len() < MAX_HITS {
                let (n, line) = &per_page[i][taken[i]];
                hits.push(format!("{}:{}: {}", pages[i].path, n, clip(line.trim(), MAX_LINE_CHARS)));
                taken[i] += 1;
            }
        }
    }

    let mut out = String::new();
    if loose {
        out.push_str(&format!(
            "No line holds “{}” word for word; these hold some of its words.\n\n",
            query.trim()
        ));
    }
    out.push_str(&hits.join("\n"));
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

    /// Named so the least relevant page sorts first by path: without ranking it would lead.
    fn ranked_folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("aside.md"), "# Aside\n\nA ripple was mentioned once.\n").unwrap();
        std::fs::write(
            dir.path().join("zripples.md"),
            "# Ripples\n\nRipples carry the sequence.\nRipples repeat in sleep.\nA ripple is brief.\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn search_leads_with_the_page_that_discusses_the_query() {
        let dir = ranked_folder();
        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "ripple" }));
        assert!(!out.is_error, "{}", out.text);
        let ripples = out.text.find("zripples.md").expect("the page about ripples");
        let aside = out.text.find("aside.md").expect("the page mentioning one");
        // Path order would put aside.md first; relevance is what decides here.
        assert!(ripples < aside, "the page about ripples should lead:\n{}", out.text);
    }

    #[test]
    fn one_page_cannot_take_the_whole_answer() {
        let dir = tempfile::tempdir().unwrap();
        let chatty: String = std::iter::once("# Chatty".to_string())
            .chain((0..40).map(|i| format!("Ripples again, line {i}.")))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("achatty.md"), chatty).unwrap();
        std::fs::write(dir.path().join("quiet.md"), "# Quiet\n\nOne ripple here.\n").unwrap();

        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "ripple" }));
        let lines: Vec<&str> = out.text.lines().collect();
        let quiet_at = lines.iter().position(|l| l.contains("quiet.md")).expect("the quiet page is shown at all");
        // The chatty page gives up its turn after PER_PAGE_HITS, so the quiet one is not buried.
        assert!(quiet_at <= PER_PAGE_HITS, "quiet.md landed at line {quiet_at}:\n{}", out.text);
    }

    #[test]
    fn a_phrase_nobody_wrote_falls_back_to_its_words() {
        let dir = ranked_folder();
        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "ripple giraffe" }));
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("word for word"), "the looser match should say so:\n{}", out.text);
        assert!(out.text.contains("zripples.md:3: Ripples carry the sequence."), "{}", out.text);
        // A single word that genuinely appears nowhere still comes back empty rather than guessing.
        let out = run(dir.path().to_str().unwrap(), &[], "search_pages", &json!({ "query": "giraffe" }));
        assert_eq!(out.text, "No page mentions \u{201c}giraffe\u{201d}.");
    }

    #[test]
    fn describes_calls_for_the_ui() {
        assert_eq!(describe("read_page", &json!({ "path": "notes/sleep.md" })), "Reading sleep.md");
        assert_eq!(describe("search_pages", &json!({ "query": "ripple" })), "Searching for “ripple”");
        assert_eq!(describe("list_pages", &json!({})), "Listing the pages");
    }
}
