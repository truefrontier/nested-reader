//! Streaming completions against OpenAI-compatible, Anthropic and Ollama APIs.

use crate::error::{AppError, Result};
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
    Done,
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
        Ok(()) => {
            let _ = channel.send(StreamEvent::Done);
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

async fn stream_ollama(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<()> {
    let base = ollama_base(req.base_url.as_deref());
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    // `think: false` keeps reasoning models from spending the token budget on hidden thinking;
    // Ollama accepts it on models without a thinking mode too.
    let mut body = json!({ "model": req.model, "messages": messages, "stream": true, "think": false });
    if let Some(max) = req.max_tokens {
        body["options"] = json!({ "num_predict": max });
    }
    let resp = ollama_client()?
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| ollama_error(&base, e))?;
    if !resp.status().is_success() {
        return Err(AppError::Message(read_error_body(resp).await));
    }
    read_ndjson(resp, cancel, |line| {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(AppError::Message(err.to_string()));
        }
        // Thinking models also send `message.thinking`; only the answer text goes to the page.
        if let Some(text) = v.pointer("/message/content").and_then(|t| t.as_str()) {
            if !text.is_empty() {
                let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
            }
        }
        Ok(!v.get("done").and_then(|d| d.as_bool()).unwrap_or(false))
    })
    .await
}

async fn stream_openai(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<()> {
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
    let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
    if let Some(max) = req.max_tokens {
        body["max_completion_tokens"] = json!(max);
        if req.provider == "custom" {
            body["max_tokens"] = json!(max);
        }
    }
    let mut builder = client()?.post(format!("{base}/chat/completions")).json(&body);
    if let Some(k) = key {
        builder = builder.bearer_auth(k);
    }
    let resp = builder.send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Message(read_error_body(resp).await));
    }
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
        if let Some(text) = v.pointer("/choices/0/delta/content").and_then(|t| t.as_str()) {
            if !text.is_empty() {
                let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
            }
        }
        Ok(true)
    })
    .await
}

async fn stream_anthropic(req: &AiRequest, channel: &Channel<StreamEvent>, cancel: &CancelToken) -> Result<()> {
    let key = api_key("anthropic")?;
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(2048),
        "messages": messages,
        "stream": true,
    });
    if let Some(sys) = &req.system {
        body["system"] = json!(sys);
    }
    let resp = client()?
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Message(read_error_body(resp).await));
    }
    read_sse(resp, cancel, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                    let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
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
    .await
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
                    Some("done") => StreamEvent::Done,
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
        assert!(matches!(events.last(), Some(StreamEvent::Done)), "last event should be Done");
        assert!(!events.iter().any(|e| matches!(e, StreamEvent::Error { .. })));
    }
}
