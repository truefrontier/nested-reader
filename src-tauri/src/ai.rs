//! Streaming completions against OpenAI-compatible, Anthropic and Ollama APIs.

use crate::error::{AppError, Result};
use crate::tools;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio_util_lite::CancelToken;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub provider: String,
    /// "key" (default) or "subscription", which routes OpenAI/Anthropic through their CLIs.
    #[serde(default)]
    pub auth: Option<String>,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// The session folder the model may read with its tools; `None` offers no tools.
    #[serde(default)]
    pub folder: Option<String>,
    /// The folders of the roots added to the session, which the tools may read too.
    #[serde(default)]
    pub roots: Vec<String>,
    /// The kind of AI ask: "quick_answer", "new_page", "deep_dive", or "refine" (for analytics).
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    /// The model is using a tool; `detail` is a short line for the UI ("Reading replay.md").
    Tool { name: String, detail: String },
    /// The stream ended. `truncated` means the model hit its token ceiling mid-answer, so the
    /// text is cut off: whoever asked must not save it as if it were the whole answer.
    Done { truncated: bool },
    Error { message: String },
}

#[derive(Serialize)]
pub struct PingResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Models the server has installed (Ollama only), so Settings can offer them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

pub const KEYCHAIN_SERVICE: &str = "app.nestedreader.nested";

pub fn api_key(provider: &str) -> Result<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider)?;
    match entry.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(k),
        Ok(_) | Err(keyring::Error::NoEntry) => Err(AppError::Message(format!(
            "No API key for {provider}. Add one in Settings › AI."
        ))),
        Err(e) => Err(e.into()),
    }
}

fn openai_base(req_base: Option<&str>, provider: &str) -> String {
    let base = match req_base {
        Some(b) if !b.trim().is_empty() => b.trim().trim_end_matches('/').to_string(),
        _ if provider == "openai" => "https://api.openai.com/v1".to_string(),
        _ => "http://localhost:11434/v1".to_string(),
    };
    base
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()?)
}

fn ollama_base(req_base: Option<&str>) -> String {
    match req_base {
        Some(b) if !b.trim().is_empty() => b.trim().trim_end_matches('/').to_string(),
        _ => "http://localhost:11434".to_string(),
    }
}

/// No overall timeout, because a local model can take minutes to finish a long refine;
/// the read timeout only trips when the server goes quiet for two minutes.
fn ollama_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(120))
        .build()?)
}

/// Whether a stream ended because the model hit its token ceiling rather than finishing.
/// Anthropic says `max_tokens`, OpenAI and Ollama say `length`.
fn hit_token_ceiling(reason: Option<&str>) -> bool {
    matches!(reason, Some("max_tokens") | Some("length"))
}

fn ollama_error(base: &str, e: reqwest::Error) -> AppError {
    if e.is_connect() {
        AppError::Message(format!("Ollama isn't running at {base}. Start it with `ollama serve`."))
    } else {
        e.into()
    }
}

/// Emits deltas on the channel until the stream ends, the token cancels or an error occurs.
pub async fn stream(req: AiRequest, channel: Channel<StreamEvent>, cancel: CancelToken) -> Result<()> {
    let subscription = req.auth.as_deref() == Some("subscription");
    let result = match (req.provider.as_str(), subscription) {
        ("anthropic", true) => crate::cli::stream_claude(&req, &channel, &cancel).await,
        ("openai", true) => crate::cli::stream_codex(&req, &channel, &cancel).await,
        ("anthropic", false) => stream_anthropic(&req, &channel, &cancel).await,
        ("openai", false) | ("custom", _) => stream_openai(&req, &channel, &cancel).await,
        ("ollama", _) => stream_ollama(&req, &channel, &cancel).await,
        ("builtin", _) => Err(AppError::Message(
            "The built-in plan is not available in this build. Choose a provider in Settings › AI.".into(),
        )),
        (other, _) => Err(AppError::Message(format!("Unknown provider: {other}"))),
    };
    match result {
        Ok(truncated) => {
            let _ = channel.send(StreamEvent::Done { truncated });
        }
        Err(e) => {
            if !cancel.is_cancelled() {
                let _ = channel.send(StreamEvent::Error { message: e.to_string() });
            }
        }
    }
    Ok(())
}

async fn read_error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/message"))
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    format!("{status}: {detail}")
}

/// Splits an SSE byte stream into `data:` payloads and hands each to `on_data`.
async fn read_sse<F>(resp: reqwest::Response, cancel: &CancelToken, mut on_data: F) -> Result<()>
where
    F: FnMut(&str) -> Result<bool>,
{
    let mut body = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = body.next().await {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:") {
                if !on_data(data.trim())? {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// Splits a newline-delimited JSON stream into lines and hands each to `on_line`.
async fn read_ndjson<F>(resp: reqwest::Response, cancel: &CancelToken, mut on_line: F) -> Result<()>
where
    F: FnMut(&str) -> Result<bool>,
{
    let mut body = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = body.next().await {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            if !line.is_empty() && !on_line(&line)? {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// The tool calls a model made in one round, however the provider spelled them.
struct ToolCall {
    id: String,
    name: String,
    input: Value,
}

/// A tool's arguments as the model streamed them: JSON text, or an object already.
fn parse_input(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or(json!({}))
}

/// Tells the UI what the model is looking at, then runs the call against the session's folders.
fn call_tool(folder: &str, roots: &[String], call: &ToolCall, channel: &Channel<StreamEvent>) -> tools::Outcome {
    let _ = channel.send(StreamEvent::Tool { name: call.name.clone(), detail: tools::describe(&call.name, &call.input) });
    tools::run(folder, roots, &call.name, &call.input)
}

/// Whether a server refused the request because of the `tools` field, so it is worth one try without.
fn rejects_tools(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("tool") && (e.contains("support") || e.contains("unknown") || e.contains("unexpected") || e.contains("invalid"))
}

async fn stream_ollama(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let base = ollama_base(req.base_url.as_deref());
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut with_tools = req.folder.is_some();
    for _round in 0..tools::MAX_ROUNDS {
        // `think: false` keeps reasoning models from spending the token budget on hidden thinking;
        // Ollama accepts it on models without a thinking mode too.
        let mut body = json!({ "model": req.model, "messages": messages, "stream": true, "think": false });
        if let Some(max) = req.max_tokens {
            body["options"] = json!({ "num_predict": max });
        }
        if with_tools {
            body["tools"] = json!(tools::openai_tools());
        }
        let resp = ollama_client()?
            .post(format!("{base}/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|e| ollama_error(&base, e))?;
        if !resp.status().is_success() {
            let err = read_error_body(resp).await;
            // A model without tool support answers plainly instead.
            if with_tools && rejects_tools(&err) {
                with_tools = false;
                continue;
            }
            return Err(AppError::Message(err));
        }
        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut done_reason: Option<String> = None;
        read_ndjson(resp, cancel, |line| {
            let v: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => return Ok(true),
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(AppError::Message(err.to_string()));
            }
            // Thinking models also send `message.thinking`; only the answer text goes to the page.
            if let Some(t) = v.pointer("/message/content").and_then(|t| t.as_str()) {
                if !t.is_empty() {
                    text.push_str(t);
                    let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                }
            }
            if let Some(list) = v.pointer("/message/tool_calls").and_then(|t| t.as_array()) {
                for (i, c) in list.iter().enumerate() {
                    let name = c.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let input = match c.pointer("/function/arguments") {
                        Some(Value::String(s)) => parse_input(s),
                        Some(v) => v.clone(),
                        None => json!({}),
                    };
                    let id = c.get("id").and_then(|i| i.as_str()).map(String::from).unwrap_or_else(|| format!("call_{}", calls.len() + i));
                    calls.push(ToolCall { id, name, input });
                }
            }
            if let Some(r) = v.get("done_reason").and_then(|r| r.as_str()) {
                done_reason = Some(r.to_string());
            }
            Ok(!v.get("done").and_then(|d| d.as_bool()).unwrap_or(false))
        })
        .await?;
        if hit_token_ceiling(done_reason.as_deref()) {
            return Ok(true);
        }
        let folder = match (&req.folder, calls.is_empty(), cancel.is_cancelled()) {
            (Some(f), false, false) => f,
            _ => return Ok(false),
        };
        let tool_calls: Vec<Value> = calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.input } }))
            .collect();
        messages.push(json!({ "role": "assistant", "content": text, "tool_calls": tool_calls }));
        for c in &calls {
            let out = call_tool(folder, &req.roots, c, channel);
            messages.push(json!({ "role": "tool", "tool_name": c.name, "tool_call_id": c.id, "content": out.text }));
        }
    }
    Ok(false)
}

async fn stream_openai(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    let key = api_key(&req.provider).ok();
    if req.provider == "openai" && key.is_none() {
        return Err(AppError::Message("No API key for OpenAI. Add one in Settings › AI.".into()));
    }
    let base = openai_base(req.base_url.as_deref(), &req.provider);
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut with_tools = req.folder.is_some();
    for _round in 0..tools::MAX_ROUNDS {
        let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
        if let Some(max) = req.max_tokens {
            body["max_completion_tokens"] = json!(max);
            if req.provider == "custom" {
                body["max_tokens"] = json!(max);
            }
        }
        if with_tools {
            body["tools"] = json!(tools::openai_tools());
        }
        let mut builder = client()?.post(format!("{base}/chat/completions")).json(&body);
        if let Some(k) = &key {
            builder = builder.bearer_auth(k);
        }
        let resp = builder.send().await?;
        if !resp.status().is_success() {
            let err = read_error_body(resp).await;
            // A Custom server that does not take `tools` answers plainly instead.
            if with_tools && req.provider == "custom" && rejects_tools(&err) {
                with_tools = false;
                continue;
            }
            return Err(AppError::Message(err));
        }
        let mut text = String::new();
        // Tool calls arrive as fragments keyed by index: the id and name first, then argument text.
        let mut partial: Vec<(String, String, String)> = Vec::new();
        let mut finish: Option<String> = None;
        read_sse(resp, cancel, |data| {
            if data == "[DONE]" {
                return Ok(false);
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return Ok(true),
            };
            if let Some(err) = v.pointer("/error/message").and_then(|m| m.as_str()) {
                return Err(AppError::Message(err.to_string()));
            }
            if let Some(t) = v.pointer("/choices/0/delta/content").and_then(|t| t.as_str()) {
                if !t.is_empty() {
                    text.push_str(t);
                    let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                }
            }
            if let Some(list) = v.pointer("/choices/0/delta/tool_calls").and_then(|t| t.as_array()) {
                for c in list {
                    let index = c.get("index").and_then(|i| i.as_u64()).unwrap_or(partial.len() as u64) as usize;
                    while partial.len() <= index {
                        partial.push((String::new(), String::new(), String::new()));
                    }
                    let slot = &mut partial[index];
                    if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                        slot.0 = id.to_string();
                    }
                    if let Some(name) = c.pointer("/function/name").and_then(|n| n.as_str()) {
                        slot.1.push_str(name);
                    }
                    if let Some(args) = c.pointer("/function/arguments").and_then(|a| a.as_str()) {
                        slot.2.push_str(args);
                    }
                }
            }
            if let Some(f) = v.pointer("/choices/0/finish_reason").and_then(|f| f.as_str()) {
                finish = Some(f.to_string());
            }
            Ok(true)
        })
        .await?;
        if hit_token_ceiling(finish.as_deref()) {
            return Ok(true);
        }
        let calls: Vec<ToolCall> = partial
            .into_iter()
            .enumerate()
            .filter(|(_, (_, name, _))| !name.is_empty())
            .map(|(i, (id, name, args))| ToolCall { id: if id.is_empty() { format!("call_{i}") } else { id }, name, input: parse_input(&args) })
            .collect();
        let folder = match (&req.folder, calls.is_empty(), cancel.is_cancelled()) {
            (Some(f), false, false) => f,
            _ => return Ok(false),
        };
        let tool_calls: Vec<Value> = calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.input.to_string() } }))
            .collect();
        messages.push(json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }, "tool_calls": tool_calls }));
        for c in &calls {
            let out = call_tool(folder, &req.roots, c, channel);
            messages.push(json!({ "role": "tool", "tool_call_id": c.id, "content": out.text }));
        }
    }
    Ok(false)
}

/// Anthropic's own host, or an Anthropic-compatible proxy named on the request (the tests use one).
fn anthropic_base(req: &AiRequest) -> String {
    match req.base_url.as_deref() {
        Some(b) if !b.trim().is_empty() => b.trim().trim_end_matches('/').to_string(),
        _ => "https://api.anthropic.com".to_string(),
    }
}

async fn stream_anthropic(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<bool> {
    // A proxy at its own base URL may hold the key itself.
    let key = match api_key("anthropic") {
        Ok(k) => k,
        Err(_) if req.base_url.is_some() => String::new(),
        Err(e) => return Err(e),
    };
    let base = anthropic_base(req);
    let mut messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    for _round in 0..tools::MAX_ROUNDS {
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens.unwrap_or(2048),
            "messages": messages,
            "stream": true,
        });
        if let Some(sys) = &req.system {
            body["system"] = json!(sys);
        }
        if req.folder.is_some() {
            body["tools"] = json!(tools::anthropic_tools());
        }
        let resp = client()?
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(AppError::Message(read_error_body(resp).await));
        }
        // Every content block is kept as it streams (text, tool_use, thinking), because the
        // whole assistant turn has to go back with the tool results.
        let mut blocks: Vec<Value> = Vec::new();
        let mut tool_json: Vec<String> = Vec::new();
        let mut stop_reason: Option<String> = None;
        read_sse(resp, cancel, |data| {
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return Ok(true),
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_start") => {
                    let mut block = v.get("content_block").cloned().unwrap_or(json!({ "type": "text", "text": "" }));
                    if block["type"] == "tool_use" {
                        block["input"] = json!({});
                    }
                    blocks.push(block);
                    tool_json.push(String::new());
                }
                Some("content_block_delta") => {
                    let i = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    if i >= blocks.len() {
                        return Ok(true);
                    }
                    match v.pointer("/delta/type").and_then(|t| t.as_str()) {
                        Some("text_delta") => {
                            if let Some(t) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                                let _ = channel.send(StreamEvent::Delta { text: t.to_string() });
                                if let Some(s) = blocks[i]["text"].as_str() {
                                    blocks[i]["text"] = json!(format!("{s}{t}"));
                                }
                            }
                        }
                        Some("input_json_delta") => {
                            if let Some(p) = v.pointer("/delta/partial_json").and_then(|p| p.as_str()) {
                                tool_json[i].push_str(p);
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(t) = v.pointer("/delta/thinking").and_then(|t| t.as_str()) {
                                if let Some(s) = blocks[i]["thinking"].as_str() {
                                    blocks[i]["thinking"] = json!(format!("{s}{t}"));
                                }
                            }
                        }
                        Some("signature_delta") => {
                            if let Some(sig) = v.pointer("/delta/signature").and_then(|s| s.as_str()) {
                                blocks[i]["signature"] = json!(sig);
                            }
                        }
                        _ => {}
                    }
                }
                Some("message_delta") => {
                    if let Some(r) = v.pointer("/delta/stop_reason").and_then(|r| r.as_str()) {
                        stop_reason = Some(r.to_string());
                    }
                }
                Some("error") => {
                    let msg = v
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("stream error");
                    return Err(AppError::Message(msg.to_string()));
                }
                Some("message_stop") => return Ok(false),
                _ => {}
            }
            Ok(true)
        })
        .await?;
        let mut calls: Vec<ToolCall> = Vec::new();
        for (block, raw) in blocks.iter_mut().zip(tool_json.iter()) {
            if block["type"] == "tool_use" {
                let input = parse_input(raw);
                block["input"] = input.clone();
                calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or("").to_string(),
                    name: block["name"].as_str().unwrap_or("").to_string(),
                    input,
                });
            }
        }
        if hit_token_ceiling(stop_reason.as_deref()) {
            return Ok(true);
        }
        let folder = match (&req.folder, stop_reason.as_deref(), calls.is_empty(), cancel.is_cancelled()) {
            (Some(f), Some("tool_use"), false, false) => f,
            _ => return Ok(false),
        };
        // The API refuses an empty text block, which a turn that goes straight to a tool can leave behind.
        let content: Vec<Value> = blocks.into_iter().filter(|b| !(b["type"] == "text" && b["text"].as_str().unwrap_or("").is_empty())).collect();
        messages.push(json!({ "role": "assistant", "content": content }));
        let results: Vec<Value> = calls
            .iter()
            .map(|c| {
                let out = call_tool(folder, &req.roots, c, channel);
                json!({ "type": "tool_result", "tool_use_id": c.id, "content": out.text, "is_error": out.is_error })
            })
            .collect();
        messages.push(json!({ "role": "user", "content": results }));
    }
    Ok(false)
}

/// Ids from an OpenAI- or Anthropic-style `{ "data": [{ "id": … }] }` listing.
fn listed_ids(v: &Value) -> Vec<String> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

/// A cheap authenticated request that proves the key, base URL and network work,
/// and returns the models on offer so Settings can list them.
pub async fn ping(provider: &str, auth: Option<&str>, base_url: &str, model: &str) -> PingResult {
    let started = Instant::now();
    let mut models: Option<Vec<String>> = None;
    let result: Result<()> = async {
        if auth == Some("subscription") {
            let list = match provider {
                "anthropic" => crate::cli::ping_claude().await?,
                "openai" => crate::cli::ping_codex().await?,
                other => return Err(AppError::Message(format!("{other} has no subscription mode"))),
            };
            models = Some(list);
            return Ok(());
        }
        let c = client()?;
        match provider {
            "ollama" => {
                let base = ollama_base(if base_url.is_empty() { None } else { Some(base_url) });
                let resp = ollama_client()?
                    .get(format!("{base}/api/tags"))
                    .send()
                    .await
                    .map_err(|e| ollama_error(&base, e))?;
                if !resp.status().is_success() {
                    return Err(AppError::Message(read_error_body(resp).await));
                }
                let v: Value = resp.json().await?;
                // Chat-capable models only, local ones first and smallest first, so the
                // head of the list is the fastest choice.
                let mut entries: Vec<(bool, u64, String)> = v
                    .get("models")
                    .and_then(|m| m.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                let name = m.get("name")?.as_str()?.to_string();
                                let family = m.pointer("/details/family").and_then(|f| f.as_str()).unwrap_or("");
                                if name.contains("embed") || family.contains("bert") {
                                    return None;
                                }
                                let cloud = m.get("remote_host").is_some() || name.ends_with("cloud");
                                let size = m.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                                Some((cloud, size, name))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                entries.sort();
                let names: Vec<String> = entries.into_iter().map(|(_, _, n)| n).collect();
                // Ollama names always carry a tag, so "llama3.2" matches "llama3.2:latest".
                let installed = model.is_empty() || names.iter().any(|n| n == model || *n == format!("{model}:latest"));
                models = Some(names);
                if !installed {
                    return Err(AppError::Message(format!("\"{model}\" isn't installed")));
                }
                Ok(())
            }
            "anthropic" => {
                let key = api_key("anthropic")?;
                let resp = c
                    .get("https://api.anthropic.com/v1/models")
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .send()
                    .await?;
                if !resp.status().is_success() {
                    return Err(AppError::Message(read_error_body(resp).await));
                }
                let v: Value = resp.json().await?;
                let ids = listed_ids(&v);
                let known = ids.is_empty() || model.is_empty() || ids.iter().any(|i| i == model);
                models = Some(ids);
                if !known {
                    return Err(AppError::Message(format!("Model \"{model}\" not found")));
                }
                Ok(())
            }
            "openai" | "custom" => {
                let base = openai_base(if base_url.is_empty() { None } else { Some(base_url) }, provider);
                let mut builder = c.get(format!("{base}/models"));
                if let Ok(k) = api_key(provider) {
                    builder = builder.bearer_auth(k);
                } else if provider == "openai" {
                    return Err(AppError::Message("No API key".into()));
                }
                let resp = builder.send().await?;
                if !resp.status().is_success() {
                    return Err(AppError::Message(read_error_body(resp).await));
                }
                let v: Value = resp.json().await?;
                let ids = listed_ids(&v);
                let known = ids.is_empty() || model.is_empty() || ids.iter().any(|i| i == model);
                models = Some(ids);
                if !known {
                    return Err(AppError::Message(format!("Model \"{model}\" not found")));
                }
                Ok(())
            }
            "builtin" => Err(AppError::Message("Built-in plan is not available in this build".into())),
            other => Err(AppError::Message(format!("Unknown provider: {other}"))),
        }
    }
    .await;
    match result {
        Ok(()) => PingResult { ok: true, ms: Some(started.elapsed().as_millis()), error: None, models },
        Err(e) => PingResult { ok: false, ms: None, error: Some(e.to_string()), models },
    }
}

/// Minimal cancellation token so streams stop when the UI moves on.
pub mod tokio_util_lite {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[derive(Clone, Default)]
    pub struct CancelToken(Arc<AtomicBool>);

    impl CancelToken {
        pub fn cancel(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
        pub fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
}

/// Live checks against a local Ollama. Run with `cargo test -- --ignored` when `ollama serve` is up.
#[cfg(test)]
mod ollama_live {
    use super::*;
    use std::sync::{Arc, Mutex};

    const MODEL: &str = "gemma4:12b";

    #[test]
    #[ignore]
    fn ping_lists_installed_models() {
        let r = tauri::async_runtime::block_on(ping("ollama", None, "", MODEL));
        assert!(r.ok, "{:?}", r.error);
        let models = r.models.expect("models");
        assert!(models.iter().any(|m| m == MODEL), "{models:?}");
    }

    #[test]
    #[ignore]
    fn ping_reports_missing_model_and_still_lists() {
        let r = tauri::async_runtime::block_on(ping("ollama", None, "", "not-a-model"));
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("\"not-a-model\" isn't installed"));
        assert!(!r.models.unwrap().is_empty());
    }

    #[test]
    #[ignore]
    fn ping_names_a_down_server() {
        let r = tauri::async_runtime::block_on(ping("ollama", None, "http://127.0.0.1:1", ""));
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("isn't running"), "expected a plain connection message");
    }

    #[test]
    #[ignore]
    fn stream_delivers_text_then_done() {
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
        let req = AiRequest {
            provider: "ollama".into(),
            auth: None,
            model: MODEL.into(),
            base_url: None,
            system: Some("Answer in one short sentence.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "What colour is the sky on a clear day?".into() }],
            max_tokens: Some(40),
            folder: None,
            roots: vec![],
            kind: None,
        };
        tauri::async_runtime::block_on(stream(req, channel, CancelToken::default())).unwrap();
        let events = events.lock().unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.to_lowercase().contains("blue"), "got: {text:?}");
        assert!(matches!(events.last(), Some(StreamEvent::Done { .. })), "last event should be Done");
        assert!(!events.iter().any(|e| matches!(e, StreamEvent::Error { .. })));
    }
}

/// The tool loops against a fake server on localhost, so they run anywhere without keys.
#[cfg(test)]
mod tool_loops {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Answers each request in turn with the given status and body, and keeps the request bodies.
    async fn serve(responses: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = seen.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut head_end = None;
                let mut length = 0usize;
                loop {
                    let mut chunk = [0u8; 4096];
                    let n = sock.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if head_end.is_none() {
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            head_end = Some(pos + 4);
                            let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                            length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse().ok())
                                .unwrap_or(0);
                        }
                    }
                    if let Some(h) = head_end {
                        if buf.len() >= h + length {
                            break;
                        }
                    }
                }
                let h = head_end.unwrap();
                let req: Value = serde_json::from_slice(&buf[h..h + length]).unwrap();
                sink.lock().unwrap().push(req);
                let reason = if status == 200 { "OK" } else { "Bad Request" };
                let reply = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                sock.write_all(reply.as_bytes()).await.unwrap();
                sock.shutdown().await.unwrap();
            }
        });
        (base, seen)
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

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("nested-").tempdir().unwrap();
        std::fs::write(dir.path().join("replay.md"), "# Replay\n\nRipples carry the sequence.\n").unwrap();
        dir
    }

    fn request(provider: &str, base: &str, folder: &str) -> AiRequest {
        AiRequest {
            provider: provider.into(),
            auth: None,
            model: "test-model".into(),
            base_url: Some(base.into()),
            system: Some("Answer briefly.".into()),
            messages: vec![ChatMessage { role: "user".into(), content: "What carries the sequence?".into() }],
            max_tokens: Some(200),
            folder: Some(folder.into()),
            roots: vec![],
            kind: None,
        }
    }

    fn texts(events: &[Value], kind: &str, field: &str) -> Vec<String> {
        events.iter().filter(|e| e["type"] == kind).map(|e| e[field].as_str().unwrap_or("").to_string()).collect()
    }

    const ANTHROPIC_TOOL_TURN: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_page\",\"input\":{}}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\": \\\"re\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"play.md\\\"}\"}}\n\n\
data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n\
data: {\"type\":\"message_stop\"}\n\n";

    const ANTHROPIC_ANSWER: &str = "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ripples \"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"carry it.\"}}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n\
data: {\"type\":\"message_stop\"}\n\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn anthropic_runs_the_tool_and_sends_the_result_back() {
        let dir = folder();
        let (base, seen) = serve(vec![(200, ANTHROPIC_TOOL_TURN), (200, ANTHROPIC_ANSWER)]).await;
        let (channel, events) = collect();
        stream(request("anthropic", &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0]["tools"].as_array().unwrap().len(), 3);
        assert_eq!(seen[0]["tools"][1]["name"], "read_page");
        let second = &seen[1]["messages"];
        assert_eq!(second.as_array().unwrap().len(), 3);
        assert_eq!(second[1]["role"], "assistant");
        // The empty text block is dropped; the tool_use block carries the parsed input.
        assert_eq!(second[1]["content"].as_array().unwrap().len(), 1);
        assert_eq!(second[1]["content"][0]["type"], "tool_use");
        assert_eq!(second[1]["content"][0]["input"], json!({ "path": "replay.md" }));
        assert_eq!(second[2]["role"], "user");
        assert_eq!(second[2]["content"][0]["type"], "tool_result");
        assert_eq!(second[2]["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(second[2]["content"][0]["is_error"], false);
        assert!(second[2]["content"][0]["content"].as_str().unwrap().contains("Ripples carry the sequence."));

        let events = events.lock().unwrap();
        assert_eq!(texts(&events, "tool", "detail"), vec!["Reading replay.md"]);
        assert_eq!(texts(&events, "delta", "text").join(""), "Ripples carry it.");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    const OPENAI_TOOL_TURN: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"search_pages\",\"arguments\":\"\"}}]}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\"\"}}]}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\": \\\"ripple\\\"}\"}}]}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
data: [DONE]\n\n";

    const OPENAI_ANSWER: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ripples.\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
data: [DONE]\n\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn openai_shape_runs_the_tool_and_sends_the_result_back() {
        let dir = folder();
        let (base, seen) = serve(vec![(200, OPENAI_TOOL_TURN), (200, OPENAI_ANSWER)]).await;
        let (channel, events) = collect();
        stream(request("custom", &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0]["tools"][0]["type"], "function");
        let second = &seen[1]["messages"];
        // system, user, assistant (tool call), tool (result)
        assert_eq!(second.as_array().unwrap().len(), 4);
        assert_eq!(second[2]["role"], "assistant");
        assert_eq!(second[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(second[2]["tool_calls"][0]["function"]["name"], "search_pages");
        assert_eq!(second[2]["tool_calls"][0]["function"]["arguments"], "{\"query\":\"ripple\"}");
        assert_eq!(second[3]["role"], "tool");
        assert_eq!(second[3]["tool_call_id"], "call_1");
        assert!(second[3]["content"].as_str().unwrap().contains("replay.md:3: Ripples carry the sequence."));

        let events = events.lock().unwrap();
        assert_eq!(texts(&events, "tool", "detail"), vec!["Searching for “ripple”"]);
        assert_eq!(texts(&events, "delta", "text").join(""), "Ripples.");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    const OLLAMA_TOOL_TURN: &str = "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"list_pages\",\"arguments\":{}}}]},\"done\":false}\n\
{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n";

    const OLLAMA_ANSWER: &str = "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"One page.\"},\"done\":false}\n\
{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn ollama_runs_the_tool_and_sends_the_result_back() {
        let dir = folder();
        let (base, seen) = serve(vec![(200, OLLAMA_TOOL_TURN), (200, OLLAMA_ANSWER)]).await;
        let (channel, events) = collect();
        stream(request("ollama", &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0]["tools"][0]["function"]["name"], "list_pages");
        let second = &seen[1]["messages"];
        assert_eq!(second.as_array().unwrap().len(), 4);
        assert_eq!(second[2]["role"], "assistant");
        assert_eq!(second[2]["tool_calls"][0]["function"]["name"], "list_pages");
        assert_eq!(second[3]["role"], "tool");
        assert_eq!(second[3]["tool_name"], "list_pages");
        assert_eq!(second[3]["content"], "replay.md — Replay");

        let events = events.lock().unwrap();
        assert_eq!(texts(&events, "tool", "detail"), vec!["Listing the pages"]);
        assert_eq!(texts(&events, "delta", "text").join(""), "One page.");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ollama_model_without_tools_answers_plainly() {
        let dir = folder();
        let refusal = "{\"error\":\"registry.ollama.ai/library/gemma3:4b does not support tools\"}";
        let (base, seen) = serve(vec![(400, refusal), (200, OLLAMA_ANSWER)]).await;
        let (channel, events) = collect();
        stream(request("ollama", &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].get("tools").is_some());
        assert!(seen[1].get("tools").is_none(), "the retry must not offer tools");
        let events = events.lock().unwrap();
        assert_eq!(texts(&events, "delta", "text").join(""), "One page.");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    // A model that runs out of room stops mid-sentence. Refine writes the answer straight over
    // the page, so `done` has to say the text is cut off or half a page silently replaces a whole one.

    const ANTHROPIC_CUT_OFF: &str = "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ripples carry\"}}\n\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n\
data: {\"type\":\"message_stop\"}\n\n";

    const OPENAI_CUT_OFF: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ripples carry\"}}]}\n\n\
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n\
data: [DONE]\n\n";

    const OLLAMA_CUT_OFF: &str = "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"Ripples carry\"},\"done\":false}\n\
{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"length\"}\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cut_off_answer_is_reported_as_truncated() {
        for (provider, body) in [
            ("anthropic", ANTHROPIC_CUT_OFF),
            ("custom", OPENAI_CUT_OFF),
            ("ollama", OLLAMA_CUT_OFF),
        ] {
            let dir = folder();
            let (base, _seen) = serve(vec![(200, body)]).await;
            let (channel, events) = collect();
            stream(request(provider, &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

            let events = events.lock().unwrap();
            // The part that arrived still streams, so the reader sees what the model managed.
            assert_eq!(texts(&events, "delta", "text").join(""), "Ripples carry", "{provider} deltas");
            let last = events.last().unwrap();
            assert_eq!(last["type"], "done", "{provider} ends with done");
            assert_eq!(last["truncated"], true, "{provider} must flag the cut-off answer");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_finished_answer_is_not_truncated() {
        for (provider, body) in [
            ("anthropic", ANTHROPIC_ANSWER),
            ("custom", OPENAI_ANSWER),
            ("ollama", OLLAMA_ANSWER),
        ] {
            let dir = folder();
            let (base, _seen) = serve(vec![(200, body)]).await;
            let (channel, events) = collect();
            stream(request(provider, &base, dir.path().to_str().unwrap()), channel, CancelToken::default()).await.unwrap();

            let events = events.lock().unwrap();
            assert_eq!(events.last().unwrap()["truncated"], false, "{provider} finished cleanly");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_folder_means_no_tools() {
        let (base, seen) = serve(vec![(200, OLLAMA_ANSWER)]).await;
        let (channel, _events) = collect();
        let mut req = request("ollama", &base, "");
        req.folder = None;
        stream(req, channel, CancelToken::default()).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].get("tools").is_none());
    }
}
