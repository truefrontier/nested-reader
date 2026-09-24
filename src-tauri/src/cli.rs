//! Subscription access through the official command-line tools: `claude -p`
//! (Claude Code, for a claude.ai plan) and `codex exec` (for a ChatGPT plan).
//! The CLIs hold the sign-in, so this app never sees a token.

use crate::ai::tokio_util_lite::CancelToken;
use crate::ai::{AiRequest, StreamEvent};
use crate::error::{AppError, Result};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

/// Claude Code resolves these aliases to the current model of each tier, cheapest first.
pub const CLAUDE_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
/// Codex has no model-list command; these are the models a ChatGPT plan offers, cheapest first.
pub const CODEX_MODELS: &[&str] = &["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"];

/// Finds a CLI even when the app was opened from Finder, where PATH is nearly empty.
fn find_bin(name: &str) -> Result<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [".local/bin", ".claude/local", ".volta/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"] {
            dirs.push(home.join(rel));
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for e in entries.flatten() {
                dirs.push(e.path().join("bin"));
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| AppError::Message(format!("`{name}` isn't installed (not found on the PATH).")))
}

/// A folder with no CLAUDE.md or project settings, so the CLIs start clean and cheap.
fn neutral_cwd() -> PathBuf {
    let dir = std::env::temp_dir().join("nested-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The CLIs take one prompt, so a multi-message exchange becomes a short transcript.
fn transcript(req: &AiRequest) -> String {
    if req.messages.len() == 1 {
        return req.messages[0].content.clone();
    }
    let mut out = String::from("Conversation so far; answer the last message.\n\n");
    for m in &req.messages {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        out.push_str(&format!("{who}: {}\n\n", m.content));
    }
    out
}

/// Claude Code's read-only tools; enough to look around the folder, nothing that writes or runs.
const CLAUDE_TOOLS: &str = "Read,Grep,Glob";

/// The line added to the instructions when the CLI may read the session folder (and the folders added to the session).
fn folder_note(req: &AiRequest) -> Option<String> {
    let folder = req.folder.as_deref()?;
    let mut note = if req.roots.is_empty() {
        format!("The session folder is {folder}. Its Markdown files are the pages; read only inside it, and ignore its .reader directory.")
    } else {
        format!(
            "The session's folders are {folder} and {}. Their Markdown files are the pages; read only inside them, and ignore their .reader directories.",
            req.roots.join(", ")
        )
    };
    // The CLI's own tools reach the whole folder (there is no per-file grant to hand them
    // instead), so a page "removed from session" can only be kept out of the answer by asking
    // the model not to touch it, the same way its own .reader directory is asked to be skipped.
    if !req.excluded.is_empty() {
        note.push_str(&format!(
            " These have been removed from the session and are not pages of it, even though they sit inside a folder above: {}.",
            req.excluded.join(", ")
        ));
    }
    Some(match &req.system {
        Some(s) if !s.trim().is_empty() => format!("{s}\n\n{note}"),
        _ => note,
    })
}

/// A short line for the UI from a CLI tool call, in the words the app's own tools use.
fn cli_tool_detail(name: &str, input: &Value) -> String {
    let path = input["file_path"].as_str().or_else(|| input["path"].as_str()).unwrap_or("");
    let base = path.rsplit('/').next().unwrap_or(path);
    match name {
        "Read" if !base.is_empty() => format!("Reading {base}"),
        "Read" => "Reading a page".to_string(),
        "Grep" => match input["pattern"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => format!("Searching for “{}”", p.chars().take(40).collect::<String>()),
            None => "Searching the pages".to_string(),
        },
        "Glob" | "LS" => "Listing the pages".to_string(),
        "Bash" => "Running a command".to_string(),
        other => format!("Using {other}"),
    }
}

fn spawn(mut cmd: Command, cwd: Option<&str>) -> Result<Child> {
    Ok(cmd
        .current_dir(cwd.map(PathBuf::from).unwrap_or_else(neutral_cwd))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?)
}

/// Feeds each JSON line of stdout to `on_line` until it returns `false` or the process ends.
/// Returns whether the process exited cleanly, plus everything it wrote to stderr.
async fn run_lines<F>(mut child: Child, cancel: &CancelToken, mut on_line: F) -> Result<(bool, String)>
where
    F: FnMut(&Value) -> Result<bool>,
{
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut s).await;
        }
        s
    });
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line?,
            // Races the read so a child that has gone quiet (a stalled tool call, a hung
            // subscription CLI) is killed as soon as the caller cancels, rather than lingering
            // until it next writes a line.
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                return Ok((true, String::new()));
            }
        };
        let Some(line) = line else { break };
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !on_line(&v)? {
            break;
        }
    }
    let status = child.wait().await?;
    let err = stderr_task.await.unwrap_or_default();
    Ok((status.success(), err))
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(|l| l.chars().take(200).collect())
}

// ---------- Claude Code ----------

pub async fn stream_claude(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let mut cmd = Command::new(find_bin("claude")?);
    // Print mode, streamed; no session file, and none of the user's hooks, settings or MCP
    // servers, which would otherwise be loaded on every question.
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
    ]);
    match &req.folder {
        // Read-only tools, approved up front (print mode cannot ask), reaching only the
        // session's folders, with enough turns to look around before answering.
        Some(folder) => {
            cmd.args(["--max-turns", "12", "--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--add-dir", folder]);
            for root in &req.roots {
                cmd.args(["--add-dir", root]);
            }
        }
        // One turn and no tools at all.
        None => {
            cmd.args(["--max-turns", "1", "--tools", ""]);
        }
    };
    if !req.model.is_empty() {
        cmd.args(["--model", &req.model]);
    }
    let system = folder_note(req).or_else(|| req.system.clone());
    if let Some(sys) = &system {
        cmd.args(["--system-prompt", sys]);
    }
    cmd.arg(transcript(req));
    let child = spawn(cmd, None)?;
    let mut streamed = false;
    let mut failure: Option<String> = None;
    let (ok, stderr) = run_lines(child, cancel, |v| {
        match v["type"].as_str() {
            Some("stream_event") => {
                if v["event"]["delta"]["type"] == "text_delta" {
                    if let Some(t) = v["event"]["delta"]["text"].as_str() {
                        streamed = true;
                        let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                    }
                }
            }
            // Each finished assistant turn arrives whole: its tool calls tell the UI what the
            // model is reading, and a CLI without partial messages gives its text here too.
            Some("assistant") => {
                if let Some(blocks) = v["message"]["content"].as_array() {
                    for b in blocks {
                        match (b["type"].as_str(), b["text"].as_str()) {
                            (Some("text"), Some(t)) if !streamed => {
                                let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                            }
                            (Some("tool_use"), _) => {
                                let name = b["name"].as_str().unwrap_or("");
                                let _ = channel.send(StreamEvent::Tool { name: name.to_string(), detail: cli_tool_detail(name, &b["input"]) });
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("result") => {
                if v["is_error"].as_bool().unwrap_or(false) {
                    let msg = v["result"].as_str().unwrap_or("Claude Code returned an error");
                    failure = Some(if msg.contains("Not logged in") {
                        "Not signed in to Claude Code. Run `claude` in a terminal and use /login.".to_string()
                    } else {
                        msg.to_string()
                    });
                }
                return Ok(false);
            }
            _ => {}
        }
        Ok(true)
    })
    .await?;
    if let Some(f) = failure {
        return Err(AppError::Message(f));
    }
    if !ok && !streamed {
        return Err(AppError::Message(last_line(&stderr).unwrap_or_else(|| "Claude Code exited with an error".into())));
    }
    Ok(false)
}

/// Proves `claude` is installed and signed in; returns the model aliases it accepts.
pub async fn ping_claude() -> Result<Vec<String>> {
    let bin = find_bin("claude")?;
    let out = Command::new(bin)
        .args(["auth", "status", "--json"])
        .current_dir(neutral_cwd())
        .stdin(Stdio::null())
        .output()
        .await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    if v["loggedIn"].as_bool() == Some(true) {
        Ok(CLAUDE_MODELS.iter().map(|m| m.to_string()).collect())
    } else {
        Err(AppError::Message("Not signed in to Claude Code. Run `claude` in a terminal and use /login.".into()))
    }
}

// ---------- Codex ----------

pub async fn stream_codex(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let mut cmd = Command::new(find_bin("codex")?);
    cmd.args(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
    if !req.model.is_empty() {
        cmd.args(["--model", &req.model]);
    }
    // `codex exec` has no system-prompt flag, so the instructions lead the prompt.
    let system = folder_note(req).or_else(|| req.system.clone());
    let prompt = match &system {
        Some(s) if !s.trim().is_empty() => format!("{s}\n\n---\n\n{}", transcript(req)),
        _ => transcript(req),
    };
    cmd.arg(prompt);
    // With the folder as its working directory, Codex's read-only sandbox lets it look at the
    // pages with its own shell; from the neutral folder it has nothing to read.
    let child = spawn(cmd, req.folder.as_deref())?;
    let mut sent = false;
    let mut failure: Option<String> = None;
    let (ok, stderr) = run_lines(child, cancel, |v| {
        match v["type"].as_str() {
            Some("item.started") if v["item"]["type"] == "command_execution" => {
                let command = v["item"]["command"].as_str().unwrap_or("").trim().replace('\n', " ");
                let short: String = command.chars().take(60).collect();
                let detail = if short.is_empty() { "Running a command".to_string() } else { format!("Running `{short}`") };
                let _ = channel.send(StreamEvent::Tool { name: "command".to_string(), detail });
            }
            Some("item.completed") if v["item"]["type"] == "agent_message" => {
                if let Some(t) = v["item"]["text"].as_str() {
                    sent = true;
                    let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                }
            }
            Some("turn.completed") => return Ok(false),
            Some("turn.failed") | Some("error") => {
                let msg = v["error"]["message"]
                    .as_str()
                    .or_else(|| v["message"].as_str())
                    .unwrap_or("Codex returned an error");
                failure = Some(msg.to_string());
                return Ok(false);
            }
            _ => {}
        }
        Ok(true)
    })
    .await?;
    if let Some(f) = failure {
        return Err(AppError::Message(f));
    }
    if !ok && !sent {
        return Err(AppError::Message(last_line(&stderr).unwrap_or_else(|| "Codex exited with an error".into())));
    }
    Ok(false)
}

/// Proves `codex` is installed and signed in; returns the models a ChatGPT plan offers.
pub async fn ping_codex() -> Result<Vec<String>> {
    let bin = find_bin("codex")?;
    let out = Command::new(bin)
        .args(["login", "status"])
        .current_dir(neutral_cwd())
        .stdin(Stdio::null())
        .output()
        .await?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() && text.contains("Logged in") {
        Ok(CODEX_MODELS.iter().map(|m| m.to_string()).collect())
    } else {
        Err(AppError::Message(
            last_line(&text).unwrap_or_else(|| "Not signed in to Codex. Run `codex login` in a terminal.".into()),
        ))
    }
}

/// Live checks against the CLIs signed in on this Mac. Run with `cargo test -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::ai::ChatMessage;
    use std::sync::{Arc, Mutex};

    fn collect() -> (Channel<StreamEvent>, Arc<Mutex<Vec<StreamEvent>>>) {
        let events: Arc<Mutex<Vec<StreamEvent>>> = Arc::default();
        let sink = events.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let v: Value = serde_json::from_str(&json).unwrap();
                let ev = match v["type"].as_str() {
                    Some("delta") => StreamEvent::Delta { text: v["text"].as_str().unwrap().to_string() },
                    Some("tool") => StreamEvent::Tool { name: v["name"].as_str().unwrap_or("").to_string(), detail: v["detail"].as_str().unwrap_or("").to_string() },
                    Some("done") => StreamEvent::Done { truncated: v["truncated"].as_bool().unwrap_or(false) },
                    _ => StreamEvent::Error { message: v["message"].as_str().unwrap_or("").to_string() },
                };
                sink.lock().unwrap().push(ev);
            }
            Ok(())
        });
        (channel, events)
    }

    #[test]
    #[ignore]
    fn claude_ping_reports_signed_in() {
        let models = tauri::async_runtime::block_on(ping_claude()).expect("signed in");
        assert_eq!(models, CLAUDE_MODELS);
    }

    #[test]
    #[ignore]
    fn claude_streams_a_short_answer() {
        let (channel, events) = collect();
        let req = AiRequest {
            provider: "anthropic".into(),
            auth: Some("subscription".into()),
            model: "haiku".into(),
            base_url: None,
            system: Some("Answer in one short sentence.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "What colour is the sky on a clear day?".into() }],
            max_tokens: Some(60),
            folder: None,
            roots: vec![],
            excluded: vec![],
            kind: None,
        };
        tauri::async_runtime::block_on(crate::ai::stream(req, channel, CancelToken::default())).unwrap();
        let events = events.lock().unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.to_lowercase().contains("blue"), "got: {text:?}");
        assert!(matches!(events.last(), Some(StreamEvent::Done { .. })), "events: {}", events.len());
    }

    /// Uses the model configured in ~/.codex/config.toml (no `-m`), so it runs on whatever
    /// the local Codex setup routes to; the point is the event parsing, not the model.
    #[test]
    #[ignore]
    fn codex_streams_with_its_configured_default_model() {
        let (channel, events) = collect();
        let req = AiRequest {
            provider: "openai".into(),
            auth: Some("subscription".into()),
            model: String::new(),
            base_url: None,
            system: Some("Answer in one short sentence.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "What colour is the sky on a clear day?".into() }],
            max_tokens: Some(60),
            folder: None,
            roots: vec![],
            excluded: vec![],
            kind: None,
        };
        tauri::async_runtime::block_on(crate::ai::stream(req, channel, CancelToken::default())).unwrap();
        let events = events.lock().unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let errors: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Error { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert!(errors.is_empty(), "errors: {errors:?}");
        assert!(text.to_lowercase().contains("blue"), "got: {text:?}");
        assert!(matches!(events.last(), Some(StreamEvent::Done { .. })));
    }

    #[test]
    #[ignore]
    fn codex_ping_gives_a_clear_answer_either_way() {
        match tauri::async_runtime::block_on(ping_codex()) {
            Ok(models) => assert_eq!(models, CODEX_MODELS),
            Err(e) => {
                let msg = e.to_string();
                assert!(!msg.trim().is_empty());
                eprintln!("codex ping: {msg}");
            }
        }
    }
}
