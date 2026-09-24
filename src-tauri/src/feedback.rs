//! The Send feedback box: the note goes to the relay in `feedback-relay/`, which files it as a
//! GitHub issue. The app carries the relay's URL, never a GitHub token.

use crate::error::{AppError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// Compiled in from `src-tauri/.cargo/config.toml` (or the shell); empty when the relay is not set up.
pub const RELAY_URL: Option<&str> = option_env!("NESTED_FEEDBACK_URL");

pub const MAX_MESSAGE: usize = 5000;

/// Largest screenshot the box will attach, before base64 encoding; the relay refuses more.
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// A screenshot attached to a feedback note. `data` is base64, without a `data:` URL prefix; the
/// frontend either reads a picked/dropped `File` into it directly, or asks `read_attachment` to read
/// a path the window's native drag-drop delivered instead.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub data: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AppInfo {
    pub version: String,
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Payload {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Attachment>,
    pub app: AppInfo,
}

/// The note as the relay wants it: trimmed, with an empty email left out.
pub fn payload(message: &str, email: Option<&str>, attachment: Option<Attachment>, version: &str) -> Result<Payload> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::Message("Write a note first.".into()));
    }
    if message.chars().count() > MAX_MESSAGE {
        return Err(AppError::Message(format!("Keep the note under {} characters.", MAX_MESSAGE)));
    }
    let email = email.map(str::trim).filter(|e| !e.is_empty()).map(str::to_owned);
    let attachment = attachment.map(validate_attachment).transpose()?;
    Ok(Payload {
        message: message.to_owned(),
        email,
        attachment,
        app: AppInfo { version: version.to_owned(), os: std::env::consts::OS, arch: std::env::consts::ARCH },
    })
}

/// The frontend already checked type and size against a real `File`, but a screenshot sent by native
/// path (`read_attachment`) or a hand-crafted request has not; this is the one place both cross.
fn validate_attachment(a: Attachment) -> Result<Attachment> {
    if !a.mime.starts_with("image/") {
        return Err(AppError::Message("Attach an image.".into()));
    }
    // Base64 runs about 4/3 the size of the bytes it holds; this bounds it without decoding first.
    if a.data.len() > (MAX_ATTACHMENT_BYTES * 4).div_ceil(3) {
        return Err(AppError::Message("Keep the screenshot under 5 MB.".into()));
    }
    Ok(a)
}

const IMAGE_MIME: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("webp", "image/webp")];

/// Reads a file the window's native drag-drop dropped into a feedback attachment. Used because that
/// drop hands over a path rather than a `File`, unlike a click-to-attach pick or a browser drop.
pub fn read_attachment(path: &str) -> Result<Attachment> {
    let path = Path::new(path);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    let mime = ext.as_deref().and_then(|e| IMAGE_MIME.iter().find(|(x, _)| *x == e)).map(|(_, m)| *m);
    let Some(mime) = mime else {
        return Err(AppError::Message("Drop a screenshot (PNG, JPEG, GIF or WebP).".into()));
    };
    let bytes = std::fs::read(path)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Message("Keep the screenshot under 5 MB.".into()));
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("screenshot").to_owned();
    Ok(Attachment { name, mime: mime.to_owned(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// The relay URL to post to, or why there is none.
pub fn relay_url(compiled: Option<&str>) -> Result<&str> {
    match compiled.map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => Ok(url),
        None => Err(AppError::Message("Feedback isn't set up in this build.".into())),
    }
}

/// Posts the note. A refusal from the relay (a plain-text reason) comes back as the error message.
pub async fn send(url: &str, payload: &Payload) -> Result<()> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?;
    let res = client.post(url).json(payload).send().await.map_err(|e| {
        if e.is_timeout() {
            AppError::Message("The feedback server didn't answer in time.".into())
        } else if e.is_connect() {
            AppError::Message("Couldn't reach the feedback server. Are you online?".into())
        } else {
            AppError::Http(e)
        }
    })?;
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let why = res.text().await.unwrap_or_default();
    let why = why.trim();
    let message = if why.is_empty() || why.len() > 200 || why.starts_with('<') || why.starts_with('{') {
        format!("The feedback server refused the note ({}).", status.as_u16())
    } else {
        why.to_owned()
    };
    Err(AppError::Message(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_trims_and_drops_an_empty_email() {
        let p = payload("  hello\n", Some("  "), None, "0.1.0").unwrap();
        assert_eq!(p.message, "hello");
        assert_eq!(p.email, None);
        assert_eq!(p.app.version, "0.1.0");
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("email"));
        let p = payload("hi", Some(" me@example.com "), None, "0.1.0").unwrap();
        assert_eq!(p.email.as_deref(), Some("me@example.com"));
    }

    #[test]
    fn payload_refuses_empty_and_oversize_notes() {
        assert!(payload("   ", None, None, "0.1.0").is_err());
        assert!(payload(&"x".repeat(MAX_MESSAGE + 1), None, None, "0.1.0").is_err());
        assert!(payload(&"x".repeat(MAX_MESSAGE), None, None, "0.1.0").is_ok());
    }

    fn image(data: &str) -> Attachment {
        Attachment { name: "shot.png".into(), mime: "image/png".into(), data: data.into() }
    }

    #[test]
    fn payload_carries_a_small_image_and_refuses_the_rest() {
        let p = payload("hi", None, Some(image("aGVsbG8=")), "0.1.0").unwrap();
        assert_eq!(p.attachment, Some(image("aGVsbG8=")));
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"attachment\""));
        assert!(payload("hi", None, None, "0.1.0").unwrap().attachment.is_none());

        let not_image = Attachment { mime: "text/plain".into(), ..image("aGVsbG8=") };
        assert!(payload("hi", None, Some(not_image), "0.1.0").is_err());

        let too_big = image(&"A".repeat((MAX_ATTACHMENT_BYTES * 4).div_ceil(3) + 4));
        assert!(payload("hi", None, Some(too_big), "0.1.0").is_err());
    }

    #[test]
    fn read_attachment_encodes_a_supported_image_and_refuses_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shot.png");
        std::fs::write(&path, b"hello").unwrap();
        let a = read_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(a.name, "shot.png");
        assert_eq!(a.mime, "image/png");
        assert_eq!(a.data, "aGVsbG8=");

        let other = dir.path().join("note.md");
        std::fs::write(&other, b"hello").unwrap();
        assert!(read_attachment(other.to_str().unwrap()).is_err());
        assert!(read_attachment(dir.path().join("missing.png").to_str().unwrap()).is_err());
    }

    #[test]
    fn relay_url_needs_a_value() {
        assert!(relay_url(None).is_err());
        assert!(relay_url(Some("  ")).is_err());
        assert_eq!(relay_url(Some("https://r.test/")).unwrap(), "https://r.test/");
    }

    /// A one-request HTTP server on localhost that answers with the given status and body.
    fn serve(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = Vec::new();
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).into_owned();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if got.len() >= head_end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            write!(s, "HTTP/1.1 {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body).unwrap();
            String::from_utf8_lossy(&got).into_owned()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn send_posts_json_and_takes_a_created_answer() {
        let (url, handle) = serve("201 Created", "{\"number\":1}");
        let p = payload("Filter box loses focus", Some("me@example.com"), None, "0.1.0").unwrap();
        send(&url, &p).await.unwrap();
        let req = handle.join().unwrap();
        assert!(req.starts_with("POST / HTTP/1.1"));
        assert!(req.contains("\"message\":\"Filter box loses focus\""));
        assert!(req.contains("\"email\":\"me@example.com\""));
        assert!(req.contains("\"version\":\"0.1.0\""));
    }

    #[tokio::test]
    async fn send_shows_the_relays_plain_reason() {
        let (url, handle) = serve("400 Bad Request", "That email address doesn't look right");
        let p = payload("hi", None, None, "0.1.0").unwrap();
        let err = send(&url, &p).await.unwrap_err().to_string();
        handle.join().unwrap();
        assert_eq!(err, "That email address doesn't look right");
        let (url, handle) = serve("502 Bad Gateway", "<html>gateway</html>");
        let err = send(&url, &p).await.unwrap_err().to_string();
        handle.join().unwrap();
        assert_eq!(err, "The feedback server refused the note (502).");
    }
}
