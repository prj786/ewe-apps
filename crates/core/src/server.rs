//! The loopback media server.
//!
//! `http://127.0.0.1:<port>/raw/<name>?path=<abs>&t=<token>` streams a file with
//! HTTP Range support (206, `Accept-Ranges`, `Content-Range`), the right content
//! type and `Content-Disposition: inline; filename=…`; `/thumb?path=&size=&t=` and
//! `/cover?path=&t=` answer PNG / image bytes. Every route needs the per-run token
//! or it is 403; only regular files are served. The port is random, the token is
//! 32 random bytes in hex, both handed to the webview through `media_server`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::thumbs::Thumbs;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaServerInfo {
    pub port: u16,
    pub token: String,
}

struct Shared {
    token: String,
    thumbs: Thumbs,
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("os randomness");
    hex::encode(bytes)
}

/// Constant-time token comparison.
pub fn token_ok(expected: &str, given: Option<&str>) -> bool {
    let Some(given) = given else { return false };
    let a = expected.as_bytes();
    let b = given.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// What a `Range` header asks for, against a file of `len` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Range {
    /// no (usable) Range header: the whole file, 200
    Full,
    /// `start..=end`, 206
    Partial { start: u64, end: u64 },
    /// 416
    Unsatisfiable,
}

/// Parse `bytes=a-b`, `bytes=a-`, `bytes=-n`. Several ranges or another unit mean
/// the whole file (allowed by RFC 9110); an empty file is only satisfiable whole.
pub fn parse_range(header: Option<&str>, len: u64) -> Range {
    let Some(h) = header else { return Range::Full };
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return Range::Full;
    };
    if spec.contains(',') {
        return Range::Full;
    }
    let Some((a, b)) = spec.split_once('-') else {
        return Range::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Range::Unsatisfiable;
    }
    if a.is_empty() {
        // suffix: the last n bytes
        let Ok(n) = b.parse::<u64>() else {
            return Range::Full;
        };
        if n == 0 {
            return Range::Unsatisfiable;
        }
        let n = n.min(len);
        return Range::Partial {
            start: len - n,
            end: len - 1,
        };
    }
    let Ok(start) = a.parse::<u64>() else {
        return Range::Full;
    };
    if start >= len {
        return Range::Unsatisfiable;
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e.min(len - 1),
            _ => return Range::Full,
        }
    };
    Range::Partial { start, end }
}

/// Content type for a file name; audio and video containers that `mime_guess`
/// leaves generic get their media type so `<video>` and `<audio>` accept them.
pub fn content_type(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let fixed = match ext.as_str() {
        "mkv" => Some("video/x-matroska"),
        "mka" => Some("audio/x-matroska"),
        "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "ts" | "m2ts" => Some("video/mp2t"),
        "opus" => Some("audio/ogg"),
        "oga" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "wav" => Some("audio/wav"),
        "avif" => Some("image/avif"),
        "jxl" => Some("image/jxl"),
        "heic" | "heif" => Some("image/heif"),
        "md" | "markdown" => Some("text/markdown; charset=utf-8"),
        "vtt" => Some("text/vtt; charset=utf-8"),
        "srt" => Some("application/x-subrip"),
        _ => None,
    };
    if let Some(t) = fixed {
        return t.to_string();
    }
    let guess = mime_guess::from_ext(&ext).first_or_octet_stream();
    if guess.type_() == mime_guess::mime::TEXT {
        format!("{}; charset=utf-8", guess.essence_str())
    } else {
        guess.essence_str().to_string()
    }
}

fn etag_for(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("\"{:x}-{:x}\"", meta.len(), mtime)
}

fn check(shared: &Shared, q: &HashMap<String, String>) -> Result<PathBuf, StatusCode> {
    if !token_ok(&shared.token, q.get("t").map(String::as_str)) {
        return Err(StatusCode::FORBIDDEN);
    }
    let path = q.get("path").ok_or(StatusCode::BAD_REQUEST)?;
    if !path.starts_with('/') || path.contains('\0') || path.len() > 4096 {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(PathBuf::from(path))
}

fn not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"))
        .unwrap_or(false)
}

async fn raw(
    State(shared): State<Arc<Shared>>,
    axum::extract::Path(name): axum::extract::Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let path = match check(&shared, &q) {
        Ok(p) => p,
        Err(code) => return code.into_response(),
    };
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let len = meta.len();
    let etag = etag_for(&meta);
    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    if let Ok(v) = HeaderValue::from_str(&content_type(&name)) {
        out.insert(header::CONTENT_TYPE, v);
    }
    let safe_name: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .collect();
    if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{safe_name}\"")) {
        out.insert(header::CONTENT_DISPOSITION, v);
    }
    if not_modified(&headers, &etag) {
        return (StatusCode::NOT_MODIFIED, out).into_response();
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (status, start, count) = match parse_range(range, len) {
        Range::Full => (StatusCode::OK, 0, len),
        Range::Partial { start, end } => {
            out.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")).unwrap(),
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        Range::Unsatisfiable => {
            out.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{len}")).unwrap(),
            );
            return (StatusCode::RANGE_NOT_SATISFIABLE, out).into_response();
        }
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    out.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    let stream = ReaderStream::with_capacity(file.take(count), 256 * 1024);
    (status, out, Body::from_stream(stream)).into_response()
}

fn image_response(bytes: Vec<u8>, mime: &str, etag: Option<String>) -> Response {
    let mut out = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(mime) {
        out.insert(header::CONTENT_TYPE, v);
    }
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    if let Some(tag) = etag
        && let Ok(v) = HeaderValue::from_str(&tag)
    {
        out.insert(header::ETAG, v);
    }
    (StatusCode::OK, out, bytes).into_response()
}

async fn thumb(
    State(shared): State<Arc<Shared>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let path = match check(&shared, &q) {
        Ok(p) => p,
        Err(code) => return code.into_response(),
    };
    let size = q
        .get("size")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(256);
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let etag = format!("\"t{size}-{}\"", etag_for(&meta).trim_matches('"'));
    if not_modified(&headers, &etag) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    match shared.thumbs.get(path, size).await {
        Some(png) => image_response(png, "image/png", Some(etag)),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn cover(
    State(shared): State<Arc<Shared>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let path = match check(&shared, &q) {
        Ok(p) => p,
        Err(code) => return code.into_response(),
    };
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let etag = format!("\"c-{}\"", etag_for(&meta).trim_matches('"'));
    if not_modified(&headers, &etag) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    match tokio::task::spawn_blocking(move || crate::cover::find(&path)).await {
        Ok(Some(c)) => image_response(c.bytes, &c.mime, Some(etag)),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A running server. Dropping it does not stop the task; it lives for the process.
pub struct MediaServer {
    pub info: MediaServerInfo,
}

/// Bind `127.0.0.1:0`, spawn the server on Tauri's runtime and return port + token.
pub fn start(thumbs: Thumbs) -> std::io::Result<MediaServer> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let shared = Arc::new(Shared {
        token: token.clone(),
        thumbs,
    });
    tauri::async_runtime::spawn(async move {
        let app = router(shared);
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("ewe-app-core: media server: {e}");
                return;
            }
        };
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("ewe-app-core: media server stopped: {e}");
        }
    });
    Ok(MediaServer {
        info: MediaServerInfo { port, token },
    })
}

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/raw/{name}", get(raw))
        .route("/thumb", get(thumb))
        .route("/cover", get(cover))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(shared)
}

/// For tests and tools: serve on an existing tokio runtime, returning the address.
pub async fn serve_on(
    thumbs: Thumbs,
    token: String,
) -> std::io::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let shared = Arc::new(Shared { token, thumbs });
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router(shared)).await;
    });
    Ok((addr, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Range::Full);
        assert_eq!(
            parse_range(Some("bytes=0-9"), 100),
            Range::Partial { start: 0, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=90-"), 100),
            Range::Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=50-500"), 100),
            Range::Partial { start: 50, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            Range::Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-1000"), 100),
            Range::Partial { start: 0, end: 99 }
        );
        assert_eq!(parse_range(Some("bytes=100-"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Range::Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), Range::Full);
        assert_eq!(parse_range(Some("bytes=9-5"), 100), Range::Full);
        assert_eq!(parse_range(Some("bytes=x-5"), 100), Range::Full);
    }

    #[test]
    fn tokens() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, random_token());
        assert!(token_ok(&t, Some(&t)));
        assert!(!token_ok(&t, Some(&t[..63])));
        assert!(!token_ok(&t, None));
        let mut wrong = t.clone();
        wrong.replace_range(0..1, if t.starts_with('a') { "b" } else { "a" });
        assert!(!token_ok(&t, Some(&wrong)));
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("a.mkv"), "video/x-matroska");
        assert_eq!(content_type("a.MP4"), "video/mp4");
        assert_eq!(content_type("a.opus"), "audio/ogg");
        assert_eq!(content_type("a.flac"), "audio/flac");
        assert_eq!(content_type("a.png"), "image/png");
        assert_eq!(content_type("a.txt"), "text/plain; charset=utf-8");
        assert_eq!(content_type("a.pdf"), "application/pdf");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    #[tokio::test]
    async fn serves_ranges_and_refuses_without_token() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("clip.bin");
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();
        let token = "secret".to_string();
        let (addr, _h) = serve_on(Thumbs::new(dir.path().join("cache")), token.clone())
            .await
            .unwrap();
        let path = file.to_string_lossy().into_owned();

        let get = |range: Option<&str>, t: &str| {
            let range = range.map(str::to_string);
            let url = format!(
                "http://{addr}/raw/clip.bin?path={}&t={t}",
                percent_encoding::utf8_percent_encode(&path, percent_encoding::NON_ALPHANUMERIC)
            );
            async move {
                let mut req = format!(
                    "GET /raw/clip.bin?{} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n",
                    url.split_once('?').unwrap().1
                );
                if let Some(r) = range {
                    req.push_str(&format!("Range: {r}\r\n"));
                }
                req.push_str("\r\n");
                let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
                tokio::io::AsyncWriteExt::write_all(&mut s, req.as_bytes())
                    .await
                    .unwrap();
                let mut buf = Vec::new();
                s.read_to_end(&mut buf).await.unwrap();
                let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                let head = String::from_utf8_lossy(&buf[..split]).into_owned();
                (head, buf[split + 4..].to_vec())
            }
        };

        let (head, body) = get(None, "wrong").await;
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
        assert!(body.is_empty());

        let (head, body) = get(None, &token).await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("accept-ranges: bytes"));
        assert!(head.contains("content-length: 1000"));
        assert_eq!(body, data);

        let (head, body) = get(Some("bytes=100-199"), &token).await;
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("content-range: bytes 100-199/1000"), "{head}");
        assert!(head.contains("content-length: 100"));
        assert_eq!(body, &data[100..200]);

        let (head, body) = get(Some("bytes=-5"), &token).await;
        assert!(head.contains("content-range: bytes 995-999/1000"), "{head}");
        assert_eq!(body, &data[995..]);

        let (head, _) = get(Some("bytes=5000-"), &token).await;
        assert!(head.starts_with("HTTP/1.1 416"), "{head}");
        assert!(head.contains("content-range: bytes */1000"));
    }
}
