//! Subscription access through the official command-line tools: `claude -p`
//! (Claude Code, for a claude.ai plan) and `codex exec` (for a ChatGPT plan).
//! The CLIs hold the sign-in, so this app never sees a token.

use crate::ai::tokio_util_lite::CancelToken;
use crate::ai::{AiRequest, StreamEvent};
use crate::error::{AppError, Result};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

/// Claude Code resolves these aliases to the current model of each tier, cheapest first.
pub const CLAUDE_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
/// Codex has no model-list command; these are the models a ChatGPT plan offers, cheapest first.
pub const CODEX_MODELS: &[&str] = &["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"];

/// Finds a CLI even when the app was opened from Finder, where PATH is nearly empty.
fn find_bin(name: &str) -> Result<PathBuf> {
    #[cfg(test)]
    if let Some(bin) = fake::BIN.with(|b| b.borrow().clone()) {
        return Ok(bin);
    }
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
/// Claude Code's web tools, offered only when Settings lets the model search the web.
const CLAUDE_WEB_TOOLS: &str = "WebSearch,WebFetch";

/// The line added to the instructions when the CLI may read the session folder (and the folders added to the session).
fn folder_note(req: &AiRequest) -> Option<String> {
    let folder = req.folder.as_deref()?;
    // "Files" so the line limits what it reads on disk, not whether it may use the web.
    let mut note = if req.roots.is_empty() {
        format!("The session folder is {folder}. Its Markdown files are the pages; read files only inside it, and ignore its .reader directory.")
    } else {
        format!(
            "The session's folders are {folder} and {}. Their Markdown files are the pages; read files only inside them, and ignore their .reader directories.",
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
        "WebSearch" => crate::tools::describe("web_search", input),
        "WebFetch" => match input["url"].as_str().and_then(|u| u.split("://").nth(1)).and_then(|r| r.split('/').next()) {
            Some(host) if !host.is_empty() => format!("Reading {host}"),
            _ => "Reading a web page".to_string(),
        },
        other => format!("Using {other}"),
    }
}

fn spawn(mut cmd: Command, cwd: Option<&str>, stdin: Stdio) -> Result<Child> {
    Ok(cmd
        .current_dir(cwd.map(PathBuf::from).unwrap_or_else(neutral_cwd))
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?)
}

/// Writes `prompt` to the child's stdin and closes it, off to one side of reading stdout: a prompt
/// this large (a page's worth of embedded images can run past argv's `ARG_MAX`) would otherwise
/// deadlock against a child that starts answering before it has finished reading its input.
fn feed_stdin(child: &mut Child, prompt: String) {
    let Some(mut stdin) = child.stdin.take() else { return };
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
    });
}

/// How long a CLI may go without writing a line before it counts as hung. Neither writes steadily:
/// `codex exec --json` writes a message only once it is whole, and Claude Code passes on nothing
/// during hidden thinking, so the three minutes the HTTP clients allow would kill good answers.
/// Ten minutes, or for a long page the time to write `max_tokens` at 50 tokens/s.
fn idle_cap(req: &AiRequest) -> Duration {
    #[cfg(test)]
    if let Some(cap) = fake::IDLE_CAP.with(|c| c.get()) {
        return cap;
    }
    Duration::from_secs((req.max_tokens.unwrap_or(0) as u64 / 50).max(600))
}

/// What `run_lines` does once `on_line` has handled a line.
enum Next {
    /// Read the next line.
    Line,
    /// Stop reading and let the process finish on its own: its last line has come.
    Wait,
    /// Stop reading and kill the process now: it has written more than the caller will take.
    Kill,
}

/// Feeds each JSON line of stdout to `on_line` until it says to stop or the process ends.
/// Returns whether the process exited cleanly (true for one killed here), plus everything it wrote
/// to stderr. Cancellation is raced against the stdout read, not just checked between lines, so a
/// child that has gone quiet (stalled, or streaming too slowly to matter) is killed as soon as it is
/// asked to stop. One that nobody cancels is killed after `idle_cap` of silence, which is an error
/// unless its last line has already come.
async fn run_lines<F>(mut child: Child, name: &str, idle_cap: Duration, cancel: &CancelToken, mut on_line: F) -> Result<(bool, String)>
where
    F: FnMut(&Value) -> Result<Next>,
{
    let stalled = || AppError::Message(format!("{name} went quiet for too long, so Nested stopped it. Try again."));
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
    let mut last_line_came = false;
    let kill = loop {
        let line = tokio::select! {
            line = lines.next_line() => line?,
            // Races the read so a child that has gone quiet (a stalled tool call, a hung
            // subscription CLI) is killed as soon as the caller cancels, rather than lingering
            // until it next writes a line. Prefer CancelToken::cancelled() (Notify) over polling.
            _ = cancel.cancelled() => break true,
            // A new timer for each read, so this limits a silence and not the whole run.
            _ = tokio::time::sleep(idle_cap) => {
                let _ = child.kill().await;
                return Err(stalled());
            }
        };
        let Some(line) = line else { break false };
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match on_line(&v)? {
            Next::Line => {}
            Next::Wait => {
                last_line_came = true;
                break false;
            }
            Next::Kill => break true,
        }
    };
    if kill {
        let _ = child.kill().await;
        return Ok((true, String::new()));
    }
    // Reading is over, but a child can still hold the stream open by never exiting.
    tokio::select! {
        (status, err) = async { (child.wait().await, stderr_task.await.unwrap_or_default()) } => Ok((status?.success(), err)),
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            Ok((true, String::new()))
        }
        _ = tokio::time::sleep(idle_cap) => {
            let _ = child.kill().await;
            // After its last line the answer is whole, so only the exit is missing. Without one,
            // nothing says the answer finished, and `done` would let a refine overwrite the page.
            if last_line_came { Ok((true, String::new())) } else { Err(stalled()) }
        }
    }
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).map(|l| l.chars().take(200).collect())
}

// ---------- Claude Code ----------

/// Everything `claude` is run with but the prompt, which goes on stdin.
fn claude_args(req: &AiRequest) -> Vec<String> {
    // Print mode, streamed; no session file, and none of the user's hooks, settings or MCP
    // servers, which would otherwise be loaded on every question.
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
    ]
    .map(String::from)
    .to_vec();
    // The read-only tools with a folder, the web tools when Settings allows the web. Each is
    // approved up front, since print mode cannot ask and stalls on a tool it would have to, and
    // they get enough turns to look around before answering. With neither, one turn and no tools.
    let mut tools: Vec<&str> = Vec::new();
    if req.folder.is_some() {
        tools.push(CLAUDE_TOOLS);
    }
    if req.web_access {
        tools.push(CLAUDE_WEB_TOOLS);
    }
    let tools = tools.join(",");
    if tools.is_empty() {
        args.extend(["--max-turns", "1", "--tools", ""].map(String::from));
    } else {
        args.extend(["--max-turns".into(), "12".into(), "--tools".into(), tools.clone(), "--allowedTools".into(), tools]);
    }
    // The file tools reach only the session's folders.
    if let Some(folder) = &req.folder {
        for dir in std::iter::once(folder).chain(&req.roots) {
            args.extend(["--add-dir".into(), dir.clone()]);
        }
    }
    if !req.model.is_empty() {
        args.extend(["--model".into(), req.model.clone()]);
    }
    if let Some(sys) = folder_note(req).or_else(|| req.system.clone()) {
        args.extend(["--system-prompt".into(), sys]);
    }
    args
}

pub async fn stream_claude(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let mut cmd = Command::new(find_bin("claude")?);
    cmd.args(claude_args(req));
    // The prompt goes on stdin, not argv: a page with embedded images can be most of a megabyte,
    // and macOS's ARG_MAX is only around that. `feed_stdin` writes it off to one side of the
    // read loop below, so a long prompt cannot deadlock against a child that starts answering
    // before it has finished reading its input.
    let mut child = spawn(cmd, None, Stdio::piped())?;
    feed_stdin(&mut child, transcript(req));
    let mut streamed = false;
    let mut failure: Option<String> = None;
    let mut stop_reason: Option<String> = None;
    let mut total_len = 0usize;
    let mut budget_exceeded = false;
    // The CLI has no `--max-tokens`, so nothing stops a runaway answer on its own — the failure
    // mode that sent a whole-page refine into a seven-minute run of hallucinated base64. This is
    // a blunt, app-side backstop: a rough chars-per-token estimate, generous enough not to cut off
    // a real answer, that kills the child rather than waiting for it to finish on its own.
    let budget_chars = req.max_tokens.map(|t| t as usize * 8).unwrap_or(32_000);
    let mut finished = false;
    let (ok, stderr) = run_lines(child, "Claude Code", idle_cap(req), cancel, |v| {
        match v["type"].as_str() {
            Some("stream_event") => {
                if v["event"]["delta"]["type"] == "text_delta" {
                    if let Some(t) = v["event"]["delta"]["text"].as_str() {
                        streamed = true;
                        total_len += t.chars().count();
                        let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                        // Killed here rather than through `cancel`, which belongs to the caller: a
                        // cancelled stream sends no last event, and this one has to end with
                        // `Done { truncated: true }`.
                        if total_len > budget_chars {
                            budget_exceeded = true;
                            return Ok(Next::Kill);
                        }
                    }
                } else if let Some(r) = v["event"]["delta"]["stop_reason"].as_str() {
                    stop_reason = Some(r.to_string());
                }
            }
            // Each finished assistant turn arrives whole: its tool calls tell the UI what the
            // model is reading, and a CLI without partial messages gives its text here too.
            Some("assistant") => {
                if let Some(r) = v["message"]["stop_reason"].as_str() {
                    stop_reason = Some(r.to_string());
                }
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
                finished = true;
                if v["is_error"].as_bool().unwrap_or(false) {
                    let msg = v["result"].as_str().unwrap_or("Claude Code returned an error");
                    failure = Some(if msg.contains("Not logged in") {
                        "Not signed in to Claude Code. Run `claude` in a terminal and use /login.".to_string()
                    } else {
                        msg.to_string()
                    });
                }
                return Ok(Next::Wait);
            }
            _ => {}
        }
        Ok(Next::Line)
    })
    .await?;
    if let Some(f) = failure {
        return Err(AppError::Message(f));
    }
    // Cut off by the budget above, or by the model's own ceiling: either way this is half an
    // answer, and `ai::stream` will refuse to let it overwrite a page.
    if budget_exceeded || stop_reason.as_deref() == Some("max_tokens") {
        return Ok(true);
    }
    // A non-zero exit is a failure even if some text streamed first: a killed or crashed child
    // leaves a partial answer that must not be mistaken for a finished one.
    if !ok {
        return Err(AppError::Message(last_line(&stderr).unwrap_or_else(|| "Claude Code exited with an error".into())));
    }
    // A CLI cut off mid-answer can still exit 0, so only the `result` line says the answer is whole.
    if !finished {
        return Err(AppError::Message("Claude Code exited before it finished its answer".into()));
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

/// Everything `codex` is run with, the prompt last.
fn codex_args(req: &AiRequest) -> Vec<String> {
    // Read-only, with no session file and none of the user's config.toml, command rules, plugins
    // or ChatGPT connectors, as Claude Code runs without the user's settings and MCP servers:
    // those bring tools (a browser, a GitHub fetch) that reach the web whatever the sandbox says,
    // and an "allow" rule (`curl`, `git push`) runs its command outside the sandbox altogether.
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "-c",
    ]
    .map(String::from)
    .to_vec();
    // Codex's own web search is set either way: left alone it defaults to searching a cached index.
    args.push(if req.web_access { r#"web_search="live""# } else { r#"web_search="disabled""# }.into());
    if !req.model.is_empty() {
        args.extend(["--model".into(), req.model.clone()]);
    }
    // `codex exec` has no system-prompt flag, so the instructions lead the prompt.
    let system = folder_note(req).or_else(|| req.system.clone());
    args.push(match &system {
        Some(s) if !s.trim().is_empty() => format!("{s}\n\n---\n\n{}", transcript(req)),
        _ => transcript(req),
    });
    args
}

pub async fn stream_codex(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let mut cmd = Command::new(find_bin("codex")?);
    cmd.args(codex_args(req));
    // With the folder as its working directory, Codex's read-only sandbox lets it look at the
    // pages with its own shell; from the neutral folder it has nothing to read.
    let child = spawn(cmd, req.folder.as_deref(), Stdio::null())?;
    let mut failure: Option<String> = None;
    let mut finished = false;
    let (ok, stderr) = run_lines(child, "Codex", idle_cap(req), cancel, |v| {
        match v["type"].as_str() {
            Some("item.started") if v["item"]["type"] == "command_execution" => {
                let command = v["item"]["command"].as_str().unwrap_or("").trim().replace('\n', " ");
                let short: String = command.chars().take(60).collect();
                let detail = if short.is_empty() { "Running a command".to_string() } else { format!("Running `{short}`") };
                let _ = channel.send(StreamEvent::Tool { name: "command".to_string(), detail });
            }
            Some("item.started") if v["item"]["type"] == "web_search" => {
                let _ = channel.send(StreamEvent::Tool { name: "web_search".to_string(), detail: crate::tools::describe("web_search", &v["item"]) });
            }
            Some("item.completed") if v["item"]["type"] == "agent_message" => {
                if let Some(t) = v["item"]["text"].as_str() {
                    let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                }
            }
            Some("turn.completed") => {
                finished = true;
                return Ok(Next::Wait);
            }
            Some("turn.failed") | Some("error") => {
                let msg = v["error"]["message"]
                    .as_str()
                    .or_else(|| v["message"].as_str())
                    .unwrap_or("Codex returned an error");
                failure = Some(msg.to_string());
                return Ok(Next::Wait);
            }
            _ => {}
        }
        Ok(Next::Line)
    })
    .await?;
    if let Some(f) = failure {
        return Err(AppError::Message(f));
    }
    // A non-zero exit is a failure even after a message: Codex can send one ("Let me look at the
    // page") before its answer, and `done` would let a whole-page refine write it in the page's place.
    if !ok {
        return Err(AppError::Message(codex_exit_error(&stderr)));
    }
    // An exit 0 without `turn.completed` leaves only the messages so far, maybe just an interim one.
    if !finished {
        return Err(AppError::Message("Codex exited before it finished its answer".into()));
    }
    Ok(false)
}

/// The error for a Codex run that failed before it answered, from what it wrote to stderr.
fn codex_exit_error(stderr: &str) -> String {
    // A Codex older than the flags in `codex_args` stops on them, and its last line
    // ("For more information, try '--help'.") would not say why.
    if stderr.contains("unexpected argument") || stderr.contains("Unknown feature flag") {
        return "This Codex CLI is too old for Nested. Update it to version 0.122 or later.".into();
    }
    last_line(stderr).unwrap_or_else(|| "Codex exited with an error".into())
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

/// How a subscription stream ends, against a stand-in `claude` that streams a little text and then
/// goes quiet. `find_bin` hands out `BIN` ahead of anything installed. It is per thread, so each
/// test sets its own and awaits the stream on that same thread (no `tokio::spawn`).
#[cfg(test)]
mod fake {
    use super::*;
    use crate::ai::ChatMessage;
    use std::cell::{Cell, RefCell};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    thread_local! {
        pub static BIN: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        /// Stands in for `idle_cap`, so a test does not wait out minutes of silence.
        pub static IDLE_CAP: Cell<Option<Duration>> = const { Cell::new(None) };
    }

    /// Three deltas of about fifty characters, then thirty seconds of silence that only a kill cuts short.
    const SCRIPT: &str = r#"#!/bin/sh
cat > /dev/null
for i in 1 2 3; do
  echo '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Ripples carry the daily sequence out to the cortex."}}}'
done
exec sleep 30
"#;

    /// Writes nothing and never exits on its own. It notes its pid first, to prove it was killed.
    const SILENT: &str = "#!/bin/sh\necho $$ > \"$0.pid\"\nexec sleep 30\n";

    const RESULT: &str = r#"{"type":"result","is_error":false}"#;

    /// Generous for a limit in a test: on a busy Mac a brand-new script can take over 300 ms to start.
    const SHORT_CAP: Duration = Duration::from_secs(3);

    fn install() -> tempfile::TempDir {
        install_script(SCRIPT, None)
    }

    fn install_script(script: &str, idle_cap: Option<Duration>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        BIN.with(|b| *b.borrow_mut() = Some(bin));
        IDLE_CAP.with(|c| c.set(idle_cap));
        dir
    }

    /// Whether the process that `SILENT` noted is still running.
    fn still_running(dir: &tempfile::TempDir) -> bool {
        let pid = std::fs::read_to_string(dir.path().join("claude.pid")).unwrap();
        std::process::Command::new("kill").args(["-0", pid.trim()]).stderr(Stdio::null()).status().unwrap().success()
    }

    fn collect() -> (Channel<StreamEvent>, Arc<Mutex<Vec<Value>>>) {
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = events.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, events)
    }

    fn request(max_tokens: u32) -> AiRequest {
        AiRequest {
            provider: "anthropic".into(),
            auth: Some("subscription".into()),
            model: String::new(),
            base_url: None,
            system: None,
            messages: vec![ChatMessage { role: "user".into(), content: "Rewrite the page.".into() }],
            max_tokens: Some(max_tokens),
            folder: None,
            roots: vec![],
            excluded: vec![],
            web_access: false,
            kind: None,
        }
    }

    fn kinds(events: &[Value]) -> Vec<String> {
        events.iter().map(|e| e["type"].as_str().unwrap_or("").to_string()).collect()
    }

    #[tokio::test]
    async fn output_past_the_budget_ends_as_truncated() {
        let _dir = install();
        let (channel, events) = collect();
        let started = Instant::now();
        // 10 tokens is an 80-character budget, which the second delta passes.
        let sent = crate::ai::stream(request(10), channel, CancelToken::default()).await;
        let events = events.lock().unwrap();
        assert!(sent);
        assert_eq!(kinds(&events), ["delta", "delta", "done"]);
        assert_eq!(events[0]["text"], "Ripples carry the daily sequence out to the cortex.");
        assert_eq!(events[2]["truncated"], true);
        // Killed, not waited for: the stand-in would otherwise sit silent for thirty seconds.
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_cancelled_stream_sends_no_last_event() {
        let _dir = install();
        let (channel, events) = collect();
        let cancel = CancelToken::default();
        let started = Instant::now();
        // Cancels once text has arrived, while the stand-in sits silent.
        let stop = async {
            while events.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            cancel.cancel();
        };
        let (sent, ()) = tokio::join!(crate::ai::stream(request(4000), channel, cancel.clone()), stop);
        assert!(!sent);
        let kinds = kinds(&events.lock().unwrap());
        assert!(!kinds.is_empty() && kinds.iter().all(|k| k == "delta"), "events: {kinds:?}");
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_silent_cli_ends_in_an_error_and_is_killed() {
        for (provider, name) in [("anthropic", "Claude Code"), ("openai", "Codex")] {
            let dir = install_script(SILENT, Some(SHORT_CAP));
            let (channel, events) = collect();
            let started = Instant::now();
            let mut req = request(4000);
            req.provider = provider.into();
            let sent = crate::ai::stream(req, channel, CancelToken::default()).await;
            let events = events.lock().unwrap();
            assert!(sent);
            assert_eq!(kinds(&events), ["error"]);
            assert_eq!(events[0]["message"], format!("{name} went quiet for too long, so Nested stopped it. Try again."));
            assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
            assert!(!still_running(&dir), "{name} was left running");
        }
    }

    #[test]
    fn a_long_page_gets_longer_than_the_ten_minutes() {
        IDLE_CAP.with(|c| c.set(None));
        assert_eq!(idle_cap(&request(4000)), Duration::from_secs(600));
        assert_eq!(idle_cap(&request(60_000)), Duration::from_secs(1200));
    }

    /// Half an answer must not pass for a finished one: `done` would let a refine overwrite the page.
    #[tokio::test]
    async fn a_cli_that_stalls_after_some_text_ends_in_an_error_not_done() {
        let _dir = install_script(SCRIPT, Some(SHORT_CAP));
        let (channel, events) = collect();
        let started = Instant::now();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        assert_eq!(kinds(&events.lock().unwrap()), ["delta", "delta", "delta", "error"]);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    /// The cap is on silence, not on the run: this one lasts far longer than the cap, but no gap does.
    #[tokio::test]
    async fn a_cli_that_keeps_writing_is_not_killed() {
        let script = format!(
            "#!/bin/sh\ncat > /dev/null\nfor i in 1 2 3 4 5 6 7 8 9 10; do\n  echo '{{\"type\":\"stream_event\",\"event\":{{\"delta\":{{\"type\":\"text_delta\",\"text\":\"x\"}}}}}}'\n  sleep 0.4\ndone\necho '{RESULT}'\n"
        );
        let _dir = install_script(&script, Some(SHORT_CAP));
        let (channel, events) = collect();
        let started = Instant::now();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events).iter().filter(|k| *k == "delta").count(), 10);
        assert_eq!(kinds(&events).last().unwrap(), "done");
        assert_eq!(events.last().unwrap()["truncated"], false);
        assert!(started.elapsed() > SHORT_CAP, "took {:?}", started.elapsed());
    }

    /// Its last line has come, so the answer is whole and is kept, though the process won't leave.
    #[tokio::test]
    async fn a_cli_that_wont_exit_after_its_last_line_still_finishes() {
        let script = format!("#!/bin/sh\ncat > /dev/null\necho '{RESULT}'\necho $$ > \"$0.pid\"\nexec sleep 30\n");
        let dir = install_script(&script, Some(SHORT_CAP));
        let (channel, events) = collect();
        let started = Instant::now();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        assert_eq!(kinds(&events.lock().unwrap()), ["done"]);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        assert!(!still_running(&dir));
    }

    /// No last line, so this is no finished answer; closing stdout must not get round the cap.
    #[tokio::test]
    async fn a_cli_that_closes_stdout_and_hangs_ends_in_an_error() {
        let _dir = install_script("#!/bin/sh\ncat > /dev/null\nexec 1>&-\nexec sleep 30\n", Some(SHORT_CAP));
        let (channel, events) = collect();
        let started = Instant::now();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        assert_eq!(kinds(&events.lock().unwrap()), ["error"]);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    fn codex(script: &str) -> (tempfile::TempDir, AiRequest) {
        let dir = install_script(script, Some(SHORT_CAP));
        let mut req = request(4000);
        req.provider = "openai".into();
        (dir, req)
    }

    const INTERIM: &str = r#"{"type":"item.completed","item":{"type":"agent_message","text":"Let me look at the page first."}}"#;

    /// Codex sends a message before it is done, so a crash after one is no answer: `done` would let a
    /// whole-page refine replace the page with that one sentence.
    #[tokio::test]
    async fn a_codex_that_crashes_after_an_interim_message_ends_in_an_error() {
        let (_dir, req) = codex(&format!("#!/bin/sh\necho '{INTERIM}'\necho 'stream disconnected before completion' >&2\nexit 1\n"));
        let (channel, events) = collect();
        assert!(crate::ai::stream(req, channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events), ["delta", "error"]);
        assert_eq!(
            events[1]["message"],
            "stream disconnected before completion"
        );
    }

    /// The other side of the crash above: a run that finishes its turn and exits cleanly is done.
    #[tokio::test]
    async fn a_codex_that_finishes_its_turn_is_done() {
        let (_dir, req) = codex(&format!(
            "#!/bin/sh\necho '{INTERIM}'\necho '{{\"type\":\"turn.completed\"}}'\n"
        ));
        let (channel, events) = collect();
        assert!(crate::ai::stream(req, channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events), ["delta", "done"]);
        assert_eq!(events[1]["truncated"], false);
    }

    const DELTA: &str = r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Ripples carry"}}}"#;
    const TURN_COMPLETED: &str = r#"{"type":"turn.completed"}"#;

    /// A CLI cut off mid-answer can still exit 0. Without its `result` line the text is only part of
    /// an answer, and `done` would let a whole-page refine write that part in the page's place.
    #[tokio::test]
    async fn a_claude_that_exits_cleanly_without_its_result_ends_in_an_error() {
        let _dir = install_script(&format!("#!/bin/sh\ncat > /dev/null\necho '{DELTA}'\n"), Some(SHORT_CAP));
        let (channel, events) = collect();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events), ["delta", "error"]);
        assert_eq!(events[1]["message"], "Claude Code exited before it finished its answer");
    }

    /// The same for Codex, where the text so far may be only an interim message.
    #[tokio::test]
    async fn a_codex_that_exits_cleanly_without_finishing_its_turn_ends_in_an_error() {
        let (_dir, req) = codex(&format!("#!/bin/sh\necho '{INTERIM}'\n"));
        let (channel, events) = collect();
        assert!(crate::ai::stream(req, channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events), ["delta", "error"]);
        assert_eq!(events[1]["message"], "Codex exited before it finished its answer");
    }

    /// The control for the Claude test above: the same run with its `result` line is done. Codex's
    /// is `a_codex_that_finishes_its_turn_is_done`.
    #[tokio::test]
    async fn a_claude_that_sends_its_result_and_exits_is_done() {
        let _dir = install_script(&format!("#!/bin/sh\ncat > /dev/null\necho '{DELTA}'\necho '{RESULT}'\n"), Some(SHORT_CAP));
        let (channel, events) = collect();
        assert!(crate::ai::stream(request(4000), channel, CancelToken::default()).await);
        let events = events.lock().unwrap();
        assert_eq!(kinds(&events), ["delta", "done"]);
        assert_eq!(events[1]["truncated"], false);
    }

    /// PR #98's case: a Codex that finishes its turn but won't leave is still done once the cap kills it.
    #[tokio::test]
    async fn a_codex_that_wont_exit_after_its_turn_still_finishes() {
        let (dir, req) = codex(&format!("#!/bin/sh\necho '{INTERIM}'\necho '{TURN_COMPLETED}'\necho $$ > \"$0.pid\"\nexec sleep 30\n"));
        let (channel, events) = collect();
        let started = Instant::now();
        assert!(crate::ai::stream(req, channel, CancelToken::default()).await);
        assert_eq!(kinds(&events.lock().unwrap()), ["delta", "done"]);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        assert!(!still_running(&dir));
    }

    /// Cancelling still works once reading is over and only the exit is being waited for.
    #[tokio::test]
    async fn a_cancel_reaches_a_cli_that_wont_exit_after_its_last_line() {
        let script = "#!/bin/sh\ncat > /dev/null\necho '{\"type\":\"stream_event\",\"event\":{\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}}'\necho '{\"type\":\"result\",\"is_error\":false}'\nexec sleep 30\n";
        let _dir = install_script(script, None);
        let (channel, events) = collect();
        let cancel = CancelToken::default();
        let started = Instant::now();
        let stop = async {
            while events.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        };
        let (sent, ()) = tokio::join!(crate::ai::stream(request(4000), channel, cancel.clone()), stop);
        assert!(!sent);
        assert_eq!(kinds(&events.lock().unwrap()), ["delta"]);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }
}

#[cfg(test)]
mod args {
    use super::*;
    use crate::ai::ChatMessage;

    fn request(folder: Option<&str>, web_access: bool) -> AiRequest {
        AiRequest {
            provider: "anthropic".into(),
            auth: Some("subscription".into()),
            model: "haiku".into(),
            base_url: None,
            system: Some("Answer briefly.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "What carries the sequence?".into() }],
            max_tokens: None,
            folder: folder.map(String::from),
            roots: vec![],
            excluded: vec![],
            web_access,
            kind: None,
        }
    }

    /// The value that follows `flag`, or `None` when the flag is not there.
    fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    fn web_tools(tools: &[Value]) -> usize {
        tools.iter().filter(|t| t["name"] == "web_search").count()
    }

    #[test]
    fn web_tools_only_when_settings_allow_the_web() {
        for folder in [None, Some("/tmp/notes")] {
            let off = request(folder, false);
            let claude = claude_args(&off);
            assert!(!claude.iter().any(|a| a.contains("Web")), "{claude:?}");
            assert_eq!(after(&claude, "--tools"), Some(if folder.is_some() { "Read,Grep,Glob" } else { "" }));
            assert_eq!(after(&codex_args(&off), "-c"), Some(r#"web_search="disabled""#));
            assert_eq!(web_tools(&crate::ai::anthropic_request_tools(&off)), 0);

            let on = request(folder, true);
            let claude = claude_args(&on);
            let want = if folder.is_some() { "Read,Grep,Glob,WebSearch,WebFetch" } else { "WebSearch,WebFetch" };
            // Offered and approved: print mode cannot ask, so a tool missing from --allowedTools stalls.
            assert_eq!(after(&claude, "--tools"), Some(want));
            assert_eq!(after(&claude, "--allowedTools"), Some(want));
            assert_eq!(after(&claude, "--max-turns"), Some("12"));
            assert_eq!(after(&codex_args(&on), "-c"), Some(r#"web_search="live""#));
            let http = crate::ai::anthropic_request_tools(&on);
            assert_eq!(web_tools(&http), 1);
            // Alongside the three folder tools when there is a folder, not instead of them.
            assert_eq!(http.len(), if folder.is_some() { 4 } else { 1 });
        }
    }

    #[test]
    fn without_a_folder_or_the_web_claude_gets_one_turn_and_no_tools() {
        let claude = claude_args(&request(None, false));
        assert_eq!(after(&claude, "--max-turns"), Some("1"));
        assert_eq!(after(&claude, "--allowedTools"), None);
        assert_eq!(after(&claude, "--add-dir"), None);
        // The web alone reaches no folder.
        assert_eq!(after(&claude_args(&request(None, true)), "--add-dir"), None);
        assert_eq!(after(&claude_args(&request(Some("/tmp/notes"), true)), "--add-dir"), Some("/tmp/notes"));
    }

    /// The user's own Codex setup brings tools that reach the web (a browser, ChatGPT
    /// connectors, rules that run `curl` outside the sandbox), so it stays out whether or not
    /// the web is allowed.
    #[test]
    fn codex_runs_without_the_users_config_rules_plugins_or_connectors() {
        for web in [false, true] {
            let codex = codex_args(&request(None, web));
            assert!(codex.contains(&"--ignore-user-config".to_string()), "{codex:?}");
            assert!(codex.contains(&"--ignore-rules".to_string()), "{codex:?}");
            let disabled: Vec<&str> = codex.windows(2).filter(|w| w[0] == "--disable").map(|w| w[1].as_str()).collect();
            assert_eq!(disabled, ["apps", "plugins"]);
            assert_eq!(after(&codex, "--sandbox"), Some("read-only"));
        }
    }

    /// A Codex too old for those flags says why, not just clap's closing line.
    #[test]
    fn an_old_codex_is_told_to_update() {
        let too_old = "This Codex CLI is too old for Nested. Update it to version 0.122 or later.";
        let clap = "error: unexpected argument '--ignore-user-config' found\n\n  tip: to pass '--ignore-user-config' as a value, use '-- --ignore-user-config'\n\nUsage: codex exec [OPTIONS] [PROMPT]\n\nFor more information, try '--help'.\n";
        assert_eq!(codex_exit_error(clap), too_old);
        assert_eq!(codex_exit_error("Error: Unknown feature flag: plugins\n"), too_old);
        assert_eq!(codex_exit_error("Error: Not logged in\n"), "Error: Not logged in");
        assert_eq!(codex_exit_error(""), "Codex exited with an error");
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
            web_access: false,
            kind: None,
        };
        tauri::async_runtime::block_on(crate::ai::stream(req, channel, CancelToken::default()));
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

    /// Uses Codex's own default model (no `-m`, and the user's config.toml is left out), so it
    /// runs on whatever Codex picks; the point is the event parsing, not the model.
    #[test]
    #[ignore]
    fn codex_streams_with_its_default_model() {
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
            web_access: false,
            kind: None,
        };
        tauri::async_runtime::block_on(crate::ai::stream(req, channel, CancelToken::default()));
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

    /// Runs a request the way the app sends it and returns the tool names it reported and its text.
    fn run(req: AiRequest) -> (Vec<String>, String) {
        let (channel, events) = collect();
        tauri::async_runtime::block_on(crate::ai::stream(req, channel, CancelToken::default()));
        let events = events.lock().unwrap();
        let mut tools = Vec::new();
        let mut text = String::new();
        for e in events.iter() {
            match e {
                StreamEvent::Tool { name, detail } => tools.push(format!("{name}: {detail}")),
                StreamEvent::Delta { text: t } => text.push_str(t),
                StreamEvent::Error { message } => panic!("error: {message}"),
                StreamEvent::Done { .. } => {}
            }
        }
        assert!(matches!(events.last(), Some(StreamEvent::Done { .. })), "no done event");
        eprintln!("tools: {tools:?}\ntext: {text}");
        (tools, text)
    }

    /// A question only the web can answer, with the web allowed in Settings.
    fn web_question(provider: &str, model: &str) -> AiRequest {
        AiRequest {
            provider: provider.into(),
            auth: Some("subscription".into()),
            model: model.into(),
            base_url: None,
            system: Some("Answer in one line.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "Search the web: what is the newest stable Rust version? Answer in one line.".into() }],
            max_tokens: Some(300),
            folder: None,
            roots: vec![],
            excluded: vec![],
            web_access: true,
            kind: None,
        }
    }

    #[test]
    #[ignore]
    fn claude_searches_the_web_when_allowed() {
        let (tools, text) = run(web_question("anthropic", "haiku"));
        assert!(tools.iter().any(|t| t.starts_with("WebSearch")), "tools: {tools:?}");
        assert!(text.contains("1."), "got: {text:?}");
    }

    #[test]
    #[ignore]
    fn codex_searches_the_web_when_allowed() {
        let (tools, text) = run(web_question("openai", "gpt-5.6-luna"));
        assert!(tools.iter().any(|t| t.starts_with("web_search")), "tools: {tools:?}");
        assert!(text.contains("1."), "got: {text:?}");
    }

    /// Without the user's config, Codex still reads the session folder with its own shell.
    #[test]
    #[ignore]
    fn codex_reads_the_folder() {
        let dir = tempfile::Builder::new().prefix("nested-").tempdir().unwrap();
        std::fs::write(dir.path().join("replay.md"), "# Replay\n\nRipples carry the sequence.\n").unwrap();
        let mut req = web_question("openai", "gpt-5.6-luna");
        req.web_access = false;
        req.folder = Some(dir.path().to_str().unwrap().into());
        req.messages[0].content = "Read replay.md: what carries the sequence? Answer in a few words.".into();
        let (_tools, text) = run(req);
        assert!(text.to_lowercase().contains("ripple"), "got: {text:?}");
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
