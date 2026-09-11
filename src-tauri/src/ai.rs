//! Streaming completions against OpenAI-compatible and Anthropic APIs.

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
#[serde(untagged)]
pub enum PingResult {
    Ok { ok: bool, ms: u128 },
    Err { ok: bool, error: String },
}

pub const KEYCHAIN_SERVICE: &str = "com.truefrontier.markdown-learner";

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

/// Emits deltas on the channel until the stream ends, the token cancels or an error occurs.
pub async fn stream(req: AiRequest, channel: Channel<StreamEvent>, cancel: CancelToken) -> Result<()> {
    let result = match req.provider.as_str() {
        "anthropic" => stream_anthropic(&req, &channel, &cancel).await,
        "openai" | "custom" => stream_openai(&req, &channel, &cancel).await,
        "builtin" => Err(AppError::Message(
            "The built-in plan is not available in this build. Choose a provider in Settings › AI.".into(),
        )),
        other => Err(AppError::Message(format!("Unknown provider: {other}"))),
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

/// A cheap authenticated request that proves the key, base URL and network work.
pub async fn ping(provider: &str, base_url: &str, model: &str) -> PingResult {
    let started = Instant::now();
    let result: Result<()> = async {
        let c = client()?;
        match provider {
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
                let known = v
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|arr| arr.iter().any(|m| m.get("id").and_then(|i| i.as_str()) == Some(model)))
                    .unwrap_or(true);
                if !known && !model.is_empty() {
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
                let known = v
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|arr| arr.iter().any(|m| m.get("id").and_then(|i| i.as_str()) == Some(model)))
                    .unwrap_or(true);
                if !known && !model.is_empty() {
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
        Ok(()) => PingResult::Ok { ok: true, ms: started.elapsed().as_millis() },
        Err(e) => PingResult::Err { ok: false, error: e.to_string() },
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
