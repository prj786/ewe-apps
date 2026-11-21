//! Web links: what the `<video>` should load for an http(s) URL.
//!
//! A link whose path names a media file, or that answers `video/*`, `audio/*`, an HLS or a
//! DASH type, plays as it is. Anything else (a YouTube `watch?v=…` page, a news article…) is
//! asked of yt-dlp (`-J`), and from its formats the one route WebKitGTK's GStreamer streams
//! is picked (the spike of 2026-11-21, AGENTS.md "Links"):
//!
//! 1. an **HLS master manifest** carrying video and audio (WebKit's `hlsdemux` follows
//!    YouTube's separate audio renditions; seeking works),
//! 2. one **progressive** file with video and audio (Twitch clips, YouTube's `18`),
//! 3. a **DASH** `.mpd` manifest (`dashdemux`; the BBC offers one).
//!
//! Separate video + audio files only (no manifest) would need a remux and are reported as
//! `unplayable` (the page offers mpv); DRM is reported as `drm`.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntry {
    pub url: String,
    pub title: Option<String>,
    pub duration: Option<f64>,
}

/// See `ResolvedLink` in `@ewe/shared` (links.ts) for the meaning of every field.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    /// "direct" | "stream" | "playlist" | "page" | "failed"
    pub kind: String,
    pub url: String,
    /// "file" | "hls" | "dash" | "progressive"
    pub route: Option<String>,
    pub title: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub site: Option<String>,
    pub live: bool,
    /// "no-ytdlp" | "no-video" | "drm" | "unplayable" | "error"
    pub problem: Option<String>,
    pub message: Option<String>,
    pub entries: Vec<LinkEntry>,
}

impl ResolvedLink {
    fn direct(url: &str, route: &str) -> Self {
        ResolvedLink {
            kind: "direct".into(),
            url: url.into(),
            route: Some(route.into()),
            site: host_of(url),
            ..Default::default()
        }
    }

    fn problem(kind: &str, url: &str, problem: &str, message: Option<String>) -> Self {
        ResolvedLink {
            kind: kind.into(),
            url: url.into(),
            site: host_of(url),
            problem: Some(problem.into()),
            message,
            ..Default::default()
        }
    }
}

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "ogv",
    "3gp", "mp3", "flac", "ogg", "oga", "opus", "wav", "m4a", "aac", "wma", "mka",
];

pub fn is_web(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// "youtube.com" for `https://www.youtube.com/watch?v=…`.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The route of a link whose path names media: `.m3u8` → hls, `.mpd` → dash, a media file.
pub fn direct_route(url: &str) -> Option<&'static str> {
    let lower = url.trim().to_ascii_lowercase();
    if ["rtsp://", "rtmp://", "rtmps://", "mms://"]
        .iter()
        .any(|s| lower.starts_with(s))
    {
        return Some("file");
    }
    let rest = lower.split_once("://")?.1;
    let path = rest.split(['?', '#']).next()?;
    let (_, path) = path.split_once('/')?;
    let last = path.rsplit('/').next()?;
    let ext = Path::new(last).extension()?.to_str()?;
    match ext {
        "m3u8" => Some("hls"),
        "mpd" => Some("dash"),
        e if MEDIA_EXTENSIONS.contains(&e) => Some("file"),
        _ => None,
    }
}

/// The route for a response's content type, when it is media.
pub fn content_type_route(content_type: &str) -> Option<&'static str> {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ct.as_str() {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => Some("hls"),
        "application/dash+xml" => Some("dash"),
        "application/ogg" => Some("file"),
        c if c.starts_with("video/") || c.starts_with("audio/") => Some("file"),
        _ => None,
    }
}

/// What the link answers (`curl`, ≤ 6 s, redirects followed); None when it does not answer.
fn content_type_of(url: &str) -> Option<String> {
    let out = run_with_timeout(
        Command::new("curl").args([
            "-sS",
            "-L",
            "--max-time",
            "6",
            "-r",
            "0-0",
            "-o",
            "/dev/null",
            "-w",
            "%{content_type}",
            "-A",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
            "--",
            url,
        ]),
        Duration::from_secs(8),
    )
    .ok()?;
    let ct = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.success && !ct.is_empty()).then_some(ct)
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Run a command, reading its output on threads (yt-dlp's JSON can be megabytes); kill it
/// after `limit`.
fn run_with_timeout(cmd: &mut Command, limit: Duration) -> Result<Output, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let read_out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let read_err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout".into());
            }
        }
    };
    Ok(Output {
        success: status.success(),
        stdout: read_out.join().unwrap_or_default(),
        stderr: read_err.join().unwrap_or_default(),
    })
}

/// yt-dlp's last `ERROR:` line → a problem and a sentence for people (its CLI advice cut).
pub fn classify_error(stderr: &str) -> (&'static str, String) {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .unwrap_or("")
        .trim_start_matches("ERROR:")
        .trim();
    // "[youtube] abc: Private video" → "Private video"
    let text = match line.strip_prefix('[') {
        Some(rest) => match rest.split_once("] ") {
            Some((_, after)) => after
                .split_once(": ")
                .filter(|(id, _)| !id.contains(' '))
                .map_or(after, |(_, msg)| msg),
            None => line,
        },
        None => line,
    };
    let mut text = text.to_string();
    for cut in [
        " Use --cookies",
        "; please report",
        " Use --list-formats",
        " See  https",
        " See https",
        " (caused by",
    ] {
        if let Some(i) = text.find(cut) {
            text.truncate(i);
        }
    }
    let text = text.trim().trim_end_matches(['.', ';', ',']).to_string();
    let lower = text.to_lowercase();
    if lower.contains("unsupported url") || lower.contains("no video") {
        return ("no-video", text);
    }
    if lower.contains("drm") {
        return ("drm", text);
    }
    if lower.contains("unable to download webpage")
        || lower.contains("name resolution")
        || lower.contains("timed out")
        || lower.contains("network is unreachable")
    {
        return (
            "error",
            "The site did not answer. Check the connection and try again.".into(),
        );
    }
    if text.is_empty() {
        return ("error", "yt-dlp could not read the page.".into());
    }
    let mut sentence: String = text.chars().take(200).collect();
    sentence.push('.');
    ("error", sentence)
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Codec {
    None,
    Known,
    Unknown,
}

fn codec(f: &Value, key: &str) -> Codec {
    match f.get(key).and_then(Value::as_str) {
        Some("none") => Codec::None,
        Some(_) => Codec::Known,
        None => Codec::Unknown,
    }
}

fn has_video(f: &Value) -> bool {
    codec(f, "vcodec") != Codec::None
}

fn has_audio(f: &Value) -> bool {
    codec(f, "acodec") != Codec::None
}

fn text<'a>(f: &'a Value, key: &str) -> &'a str {
    f.get(key).and_then(Value::as_str).unwrap_or("")
}

fn web_url(f: &Value, key: &str) -> Option<String> {
    let u = text(f, key);
    is_web(u).then(|| u.to_string())
}

fn usable(f: &Value) -> bool {
    !f.get("has_drm").and_then(Value::as_bool).unwrap_or(false)
        && text(f, "ext") != "mhtml"
        && text(f, "protocol") != "mhtml"
        && !text(f, "format_note").contains("storyboard")
        && (has_video(f) || has_audio(f))
}

fn height(f: &Value) -> i64 {
    f.get("height").and_then(Value::as_i64).unwrap_or(0)
}

/// Higher is better: up to 1080 lines the taller the better, above that the smaller (a
/// laptop gains nothing from 4K over the network); mp4 + H.264 before the rest.
fn rank(f: &Value) -> (i64, i64, i64) {
    let h = height(f);
    let size = if h <= 1080 { h } else { 1080 - (h - 1080) };
    let ext = match text(f, "ext") {
        "mp4" | "m4v" => 2,
        "webm" => 1,
        _ => 0,
    };
    let v = text(f, "vcodec");
    let h264 = i64::from(v.starts_with("avc") || v.starts_with("h264"));
    let tbr = f.get("tbr").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    (size, ext * 2 + h264, tbr)
}

/// A group of formats (one manifest) holds what the video needs.
fn complete(group: &[&Value], needs_video: bool, needs_audio: bool) -> bool {
    (!needs_video || group.iter().any(|f| has_video(f)))
        && (!needs_audio || group.iter().any(|f| has_audio(f)))
}

fn best_manifest(
    formats: &[&Value],
    protocol: impl Fn(&str) -> bool,
    needs_video: bool,
    needs_audio: bool,
) -> Option<String> {
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for f in formats
        .iter()
        .copied()
        .filter(|f| protocol(text(f, "protocol")))
    {
        let Some(m) = web_url(f, "manifest_url") else {
            continue;
        };
        match groups.iter_mut().find(|(k, _)| *k == m) {
            Some((_, g)) => g.push(f),
            None => groups.push((m, vec![f])),
        }
    }
    groups
        .into_iter()
        .filter(|(_, g)| complete(g, needs_video, needs_audio))
        .max_by_key(|(_, g)| g.iter().map(|f| rank(f)).max())
        .map(|(m, _)| m)
}

fn best_single(
    formats: &[&Value],
    protocol: impl Fn(&str) -> bool,
    needs_video: bool,
    needs_audio: bool,
) -> Option<String> {
    formats
        .iter()
        .copied()
        .filter(|f| protocol(text(f, "protocol")))
        .filter(|f| complete(&[f], needs_video, needs_audio))
        .filter(|f| web_url(f, "url").is_some())
        .max_by_key(|f| rank(f))
        .and_then(|f| web_url(f, "url"))
}

fn is_hls(p: &str) -> bool {
    p.starts_with("m3u8")
}

fn is_progressive(p: &str) -> bool {
    matches!(p, "https" | "http" | "")
}

fn is_dash(p: &str) -> bool {
    p == "http_dash_segments" || p == "dash"
}

fn thumbnail_of(info: &Value) -> Option<String> {
    // a template left in the URL ("…/$widthxn/…", the BBC) is no picture
    let ok = |u: &str| is_web(u) && !u.contains('$');
    if let Some(t) = info.get("thumbnail").and_then(Value::as_str)
        && ok(t)
    {
        return Some(t.to_string());
    }
    info.get("thumbnails")?
        .as_array()?
        .iter()
        .rev()
        .filter_map(|t| t.get("url").and_then(Value::as_str))
        .find(|u| ok(u))
        .map(str::to_string)
}

fn meta(info: &Value, into: &mut ResolvedLink) {
    let title = text(info, "title").trim();
    if !title.is_empty() {
        into.title = Some(title.to_string());
    }
    into.duration = info
        .get("duration")
        .and_then(Value::as_f64)
        .filter(|d| d.is_finite() && *d > 0.0);
    into.thumbnail = thumbnail_of(info);
    into.live = info
        .get("is_live")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let domain = text(info, "webpage_url_domain");
    if !domain.is_empty() {
        into.site = Some(domain.trim_start_matches("www.").to_string());
    } else if let Some(u) = web_url(info, "webpage_url") {
        into.site = host_of(&u);
    }
}

/// From yt-dlp's `-J` answer, the one thing WebKit can play (pure; see the module docs).
pub fn pick(info: &Value, link: &str) -> ResolvedLink {
    if text(info, "_type") == "playlist" {
        let entries = info
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // a page whose one video came back as a playlist of full entries (the BBC)
        if let Some(full) = entries.iter().find(|e| e.get("formats").is_some()) {
            return pick(full, link);
        }
        let list: Vec<LinkEntry> = entries
            .iter()
            .filter_map(|e| {
                let url = web_url(e, "url").or_else(|| web_url(e, "webpage_url"))?;
                Some(LinkEntry {
                    url,
                    title: Some(text(e, "title").trim().to_string()).filter(|t| !t.is_empty()),
                    duration: e.get("duration").and_then(Value::as_f64),
                })
            })
            .collect();
        if list.is_empty() {
            return ResolvedLink::problem("page", link, "no-video", None);
        }
        let mut r = ResolvedLink {
            kind: "playlist".into(),
            url: link.into(),
            entries: list,
            ..Default::default()
        };
        meta(info, &mut r);
        return r;
    }

    let all: Vec<&Value> = match info.get("formats").and_then(Value::as_array) {
        Some(f) if !f.is_empty() => f.iter().collect(),
        // a single-format answer (yt-dlp's generic extractor on a plain file)
        _ if info.get("url").is_some() => vec![info],
        _ => Vec::new(),
    };
    let formats: Vec<&Value> = all.iter().copied().filter(|f| usable(f)).collect();
    let drm = info
        .get("_has_drm")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || all
            .iter()
            .any(|f| f.get("has_drm").and_then(Value::as_bool).unwrap_or(false));
    let mut r = if formats.is_empty() {
        ResolvedLink::problem("page", link, if drm { "drm" } else { "no-video" }, None)
    } else {
        // a silent clip or a song has no other kind to wait for
        let needs_video = formats.iter().any(|f| has_video(f));
        let needs_audio = formats.iter().any(|f| has_audio(f));
        let chosen = best_manifest(&formats, is_hls, needs_video, needs_audio)
            .map(|u| (u, "hls"))
            .or_else(|| {
                best_single(&formats, is_progressive, needs_video, needs_audio)
                    .map(|u| (u, "progressive"))
            })
            .or_else(|| best_single(&formats, is_hls, needs_video, needs_audio).map(|u| (u, "hls")))
            .or_else(|| {
                best_manifest(&formats, is_dash, needs_video, needs_audio).map(|u| (u, "dash"))
            });
        match chosen {
            Some((url, route)) => ResolvedLink {
                kind: "stream".into(),
                url,
                route: Some(route.into()),
                ..Default::default()
            },
            None if drm => ResolvedLink::problem("page", link, "drm", None),
            None => ResolvedLink::problem("failed", link, "unplayable", None),
        }
    };
    meta(info, &mut r);
    if r.site.is_none() {
        r.site = host_of(link);
    }
    r
}

/// yt-dlp `-J` on a page: Ok(json) or Err((problem, sentence)).
fn ask_ytdlp(bin: &Path, url: &str) -> Result<Value, (&'static str, String)> {
    let out = run_with_timeout(
        Command::new(bin).args([
            "-J",
            "--no-playlist",
            "--flat-playlist",
            "--playlist-end",
            "200",
            "--no-warnings",
            "--no-progress",
            "--",
            url,
        ]),
        Duration::from_secs(60),
    )
    .map_err(|e| {
        if e == "timeout" {
            ("error", "yt-dlp took too long to answer.".to_string())
        } else {
            ("error", format!("yt-dlp could not run: {e}."))
        }
    })?;
    if !out.success {
        return Err(classify_error(&String::from_utf8_lossy(&out.stderr)));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| {
        (
            "error",
            "yt-dlp gave an answer ewe Player cannot read.".to_string(),
        )
    })
}

/// What to play for a link (network: curl, yt-dlp; call off the main thread).
pub fn resolve(url: &str) -> ResolvedLink {
    let url = url.trim();
    if !is_web(url) {
        // rtsp://, rtmp://… go straight to GStreamer
        return ResolvedLink::direct(url, "file");
    }
    if let Some(route) = direct_route(url) {
        return ResolvedLink::direct(url, route);
    }
    let content_type = content_type_of(url);
    if let Some(route) = content_type.as_deref().and_then(content_type_route) {
        return ResolvedLink::direct(url, route);
    }
    let Some(bin) = crate::support::ytdlp_path() else {
        return match content_type {
            // it did not answer: let GStreamer try, as before
            None => ResolvedLink::direct(url, "file"),
            Some(_) => ResolvedLink::problem("page", url, "no-ytdlp", None),
        };
    };
    match ask_ytdlp(&bin, url) {
        Ok(info) => pick(&info, url),
        Err((problem, message)) => {
            let kind = if problem == "error" { "failed" } else { "page" };
            ResolvedLink::problem(kind, url, problem, Some(message))
        }
    }
}

/// Run a program detached from the player (its exit is reaped on a thread, never waited for).
fn spawn_detached(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {e}", program.display()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The page in ewe Browser (or the default browser when ewe Browser is not there).
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !is_web(url) {
        return Err("not a web address".into());
    }
    match crate::support::find_on_path("ewe-browser") {
        Some(browser) => spawn_detached(&browser, &[url]),
        None => spawn_detached(Path::new("xdg-open"), &[url]),
    }
}

/// A link or a file in mpv (which finds the video on a page with the same yt-dlp).
pub fn open_in_mpv(target: &str) -> Result<(), String> {
    let mpv = crate::support::find_on_path("mpv").ok_or("mpv is not installed")?;
    if !is_web(target) && !target.starts_with('/') {
        return Err("not a web address or a file".into());
    }
    let hook = crate::support::ytdlp_path()
        .map(|p| format!("--script-opts=ytdl_hook-ytdl_path={}", p.display()));
    let mut args = vec!["--force-window=immediate"];
    if let Some(h) = hook.as_deref() {
        args.push(h);
    }
    args.push("--");
    args.push(target);
    spawn_detached(&mpv, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PAGE: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

    #[test]
    fn media_links_need_no_ytdlp() {
        assert_eq!(
            direct_route("https://a.example/x/master.m3u8?t=1"),
            Some("hls")
        );
        assert_eq!(direct_route("https://a.example/v/Clip.MP4"), Some("file"));
        assert_eq!(direct_route("https://a.example/s.mpd#t=3"), Some("dash"));
        assert_eq!(direct_route("rtsp://cam.local/live"), Some("file"));
        assert_eq!(direct_route(PAGE), None);
        assert_eq!(direct_route("https://example.com/"), None);
        assert_eq!(direct_route("https://example.com"), None);
        assert_eq!(direct_route("https://example.com/news.html"), None);
        assert_eq!(content_type_route("video/mp4"), Some("file"));
        assert_eq!(content_type_route("Audio/MPEG; charset=x"), Some("file"));
        assert_eq!(
            content_type_route("application/vnd.apple.mpegurl"),
            Some("hls")
        );
        assert_eq!(content_type_route("application/dash+xml"), Some("dash"));
        assert_eq!(content_type_route("text/html; charset=utf-8"), None);
    }

    #[test]
    fn hosts_and_web_urls() {
        assert_eq!(host_of(PAGE).as_deref(), Some("youtube.com"));
        assert_eq!(
            host_of("https://user@clips.twitch.tv/x").as_deref(),
            Some("clips.twitch.tv")
        );
        assert!(is_web(PAGE));
        assert!(!is_web("file:///home/me/a.mp4"));
        assert!(!is_web("https://a b"));
    }

    /// YouTube, 2026-11-21 (trimmed): an HLS master with video-only variants + audio
    /// renditions, DASH https formats, progressive `18`, storyboards.
    fn youtube() -> Value {
        let m = "https://manifest.googlevideo.com/api/manifest/hls_variant/x/file/index.m3u8";
        json!({
            "title": "Big Buck Bunny 60fps 4K",
            "duration": 635,
            "thumbnail": "https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/maxresdefault.webp",
            "webpage_url_domain": "youtube.com",
            "is_live": false,
            "formats": [
                {"format_id": "sb0", "ext": "mhtml", "protocol": "mhtml", "vcodec": "none", "acodec": "none", "url": "https://i.ytimg.com/sb"},
                {"format_id": "233", "protocol": "m3u8_native", "vcodec": "none", "manifest_url": m, "url": "https://manifest.googlevideo.com/233"},
                {"format_id": "140", "protocol": "https", "vcodec": "none", "acodec": "mp4a.40.2", "url": "https://rr1.googlevideo.com/140"},
                {"format_id": "18", "protocol": "https", "ext": "mp4", "height": 360, "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "url": "https://rr1.googlevideo.com/18"},
                {"format_id": "230", "protocol": "m3u8_native", "ext": "mp4", "height": 360, "vcodec": "avc1.4D401E", "acodec": "none", "manifest_url": m, "url": "https://manifest.googlevideo.com/230"},
                {"format_id": "312", "protocol": "m3u8_native", "ext": "mp4", "height": 1080, "vcodec": "avc1.64002A", "acodec": "none", "manifest_url": m, "url": "https://manifest.googlevideo.com/312"},
                {"format_id": "137", "protocol": "https", "ext": "mp4", "height": 1080, "vcodec": "avc1.640028", "acodec": "none", "url": "https://rr1.googlevideo.com/137"}
            ]
        })
    }

    #[test]
    fn youtube_plays_its_hls_master() {
        let r = pick(&youtube(), PAGE);
        assert_eq!(r.kind, "stream");
        assert_eq!(r.route.as_deref(), Some("hls"));
        assert!(r.url.ends_with("hls_variant/x/file/index.m3u8"));
        assert_eq!(r.title.as_deref(), Some("Big Buck Bunny 60fps 4K"));
        assert_eq!(r.duration, Some(635.0));
        assert_eq!(r.site.as_deref(), Some("youtube.com"));
        assert!(r.thumbnail.unwrap().ends_with("maxresdefault.webp"));
    }

    #[test]
    fn without_hls_youtube_falls_back_to_the_progressive_file() {
        let mut info = youtube();
        let formats = info["formats"].as_array_mut().unwrap();
        formats.retain(|f| f["protocol"] != "m3u8_native");
        let r = pick(&info, PAGE);
        assert_eq!(r.route.as_deref(), Some("progressive"));
        assert_eq!(r.url, "https://rr1.googlevideo.com/18");
    }

    #[test]
    fn separate_video_and_audio_only_is_unplayable() {
        let info = json!({"title": "x", "formats": [
            {"protocol": "https", "vcodec": "avc1", "acodec": "none", "url": "https://a/v"},
            {"protocol": "https", "vcodec": "none", "acodec": "opus", "url": "https://a/a"}
        ]});
        let r = pick(&info, PAGE);
        assert_eq!(r.kind, "failed");
        assert_eq!(r.problem.as_deref(), Some("unplayable"));
        assert_eq!(r.title.as_deref(), Some("x"));
    }

    #[test]
    fn twitch_clip_progressive_with_unknown_codecs() {
        let info = json!({"title": "EA Play", "duration": 32.1, "formats": [
            {"format_id": "1080", "protocol": "https", "ext": "mp4", "height": 1080, "url": "https://d1.cloudfront.net/1080/index.mp4"},
            {"format_id": "720", "protocol": "https", "ext": "mp4", "height": 720, "url": "https://d1.cloudfront.net/720/index.mp4"}
        ]});
        let r = pick(&info, "https://clips.twitch.tv/FaintLightGullWholeWheat");
        assert_eq!(r.route.as_deref(), Some("progressive"));
        assert!(r.url.contains("/1080/"));
        assert_eq!(r.site.as_deref(), Some("clips.twitch.tv"));
    }

    #[test]
    fn twitch_vod_muxed_variants() {
        let m = "https://usher.ttvnw.net/vod/635475444.m3u8?allow_source=true";
        let info = json!({"title": "Riot Games", "formats": [
            {"format_id": "Audio_Only", "protocol": "m3u8_native", "vcodec": "none", "acodec": "mp4a.40.2", "manifest_url": m, "url": "https://d2.cloudfront.net/audio/index.m3u8"},
            {"format_id": "720p", "protocol": "m3u8_native", "height": 720, "vcodec": "avc1.4D401F", "acodec": "mp4a.40.2", "manifest_url": m, "url": "https://d2.cloudfront.net/720p/index.m3u8"}
        ]});
        let r = pick(&info, "https://www.twitch.tv/videos/635475444");
        assert_eq!((r.kind.as_str(), r.url.as_str()), ("stream", m));
    }

    #[test]
    fn a_page_of_one_video_as_a_playlist_bbc() {
        let info = json!({"_type": "playlist", "title": "Page", "entries": [
            {"title": "Why France is making this woman a national hero", "duration": 125,
             "thumbnail": "https://ichef.bbci.co.uk/images/ic/$widthxn/p0b77dky.jpg",
             "thumbnails": [{"url": "https://ichef.bbci.co.uk/images/ic/1920x1080/p0b77dky.jpg"}],
             "formats": [
                {"protocol": "http_dash_segments", "vcodec": "avc3.42C015", "acodec": "none", "manifest_url": "http://vod-dash.example/x.mpd", "url": "http://vod-dash.example/x.mpd"},
                {"protocol": "http_dash_segments", "vcodec": "none", "acodec": "mp4a.40.5", "manifest_url": "http://vod-dash.example/x.mpd", "url": "http://vod-dash.example/x.mpd"},
                {"protocol": "m3u8_native", "height": 216, "vcodec": "avc1.42C015", "acodec": "mp4a.40.5", "manifest_url": "http://vod-hls.example/x.m3u8", "url": "http://vod-hls.example/v.m3u8"}
            ]}
        ]});
        let r = pick(&info, "https://www.bbc.com/news/av/world-europe-59468682");
        assert_eq!(r.route.as_deref(), Some("hls"));
        assert_eq!(r.url, "http://vod-hls.example/x.m3u8");
        assert_eq!(
            r.title.as_deref(),
            Some("Why France is making this woman a national hero")
        );
        assert_eq!(
            r.thumbnail.as_deref(),
            Some("https://ichef.bbci.co.uk/images/ic/1920x1080/p0b77dky.jpg")
        );
        // without HLS the DASH manifest is next
        let mut dash = info.clone();
        dash["entries"][0]["formats"]
            .as_array_mut()
            .unwrap()
            .retain(|f| f["protocol"] != "m3u8_native");
        let r = pick(&dash, "https://www.bbc.com/news/av/x");
        assert_eq!(
            (r.route.as_deref(), r.url.as_str()),
            (Some("dash"), "http://vod-dash.example/x.mpd")
        );
    }

    #[test]
    fn a_playlist_page_becomes_entries() {
        let info = json!({"_type": "playlist", "title": "Talks", "entries": [
            {"url": "https://www.youtube.com/watch?v=a", "title": "One", "duration": 61.0},
            {"url": "https://www.youtube.com/watch?v=b", "title": ""},
            {"url": "not-a-url"}
        ]});
        let r = pick(&info, "https://www.youtube.com/playlist?list=x");
        assert_eq!(r.kind, "playlist");
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].title.as_deref(), Some("One"));
        assert_eq!(r.entries[1].title, None);
        let empty = pick(&json!({"_type": "playlist", "entries": []}), PAGE);
        assert_eq!(empty.problem.as_deref(), Some("no-video"));
    }

    #[test]
    fn drm_and_nothing() {
        let info = json!({"title": "Locked", "_has_drm": true, "formats": [
            {"protocol": "m3u8_native", "vcodec": "avc1", "acodec": "none", "has_drm": true, "manifest_url": "https://v/x.m3u8"}
        ]});
        let r = pick(&info, "https://player.vimeo.com/video/1");
        assert_eq!(r.kind, "page");
        assert_eq!(r.problem.as_deref(), Some("drm"));
        assert_eq!(r.title.as_deref(), Some("Locked"));
        let none = pick(&json!({"title": "x", "formats": []}), PAGE);
        assert_eq!(none.problem.as_deref(), Some("no-video"));
    }

    #[test]
    fn audio_only_and_silent_videos_play() {
        let song = json!({"formats": [
            {"protocol": "https", "vcodec": "none", "acodec": "opus", "abr": 64, "url": "https://s/a.opus"},
            {"protocol": "m3u8_native", "vcodec": "none", "acodec": "mp4a", "url": "https://s/a.m3u8"}
        ]});
        assert_eq!(pick(&song, PAGE).url, "https://s/a.opus");
        let gif = json!({"formats": [
            {"protocol": "https", "height": 480, "vcodec": "avc1", "acodec": "none", "url": "https://v/480.mp4"}
        ]});
        assert_eq!(pick(&gif, PAGE).url, "https://v/480.mp4");
        // generic extractor: the answer is the format
        let plain = json!({"title": "file", "url": "https://x/file.bin", "protocol": "https"});
        assert_eq!(pick(&plain, PAGE).url, "https://x/file.bin");
    }

    #[test]
    fn prefers_1080_over_4k() {
        let info = json!({"formats": [
            {"protocol": "https", "height": 2160, "vcodec": "vp9", "acodec": "opus", "url": "https://v/2160"},
            {"protocol": "https", "height": 1080, "ext": "mp4", "vcodec": "avc1", "acodec": "aac", "url": "https://v/1080"},
            {"protocol": "https", "height": 720, "ext": "mp4", "vcodec": "avc1", "acodec": "aac", "url": "https://v/720"}
        ]});
        assert_eq!(pick(&info, PAGE).url, "https://v/1080");
    }

    #[test]
    fn yt_dlp_errors_in_words() {
        let (p, m) = classify_error(
            "WARNING: x\nERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.\n",
        );
        assert_eq!(p, "error");
        assert_eq!(
            m,
            "Private video. Sign in if you've been granted access to this video."
        );
        let (p, _) = classify_error("ERROR: Unsupported URL: https://example.com/\n");
        assert_eq!(p, "no-video");
        let (p, _) = classify_error(
            "ERROR: [vimeo] 1: No video formats found!; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues",
        );
        assert_eq!(p, "no-video");
        let (p, _) = classify_error("ERROR: [generic] x: This video is DRM protected");
        assert_eq!(p, "drm");
        let (p, m) = classify_error(
            "ERROR: [generic] Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution> (caused by URLError(...))",
        );
        assert_eq!(p, "error");
        assert!(m.starts_with("The site did not answer"));
        assert_eq!(classify_error("").1, "yt-dlp could not read the page.");
    }

    /// By hand, with the network: `EWE_LINK=<url> EWE_PLAYER_YTDLP=<yt-dlp> cargo test -p
    /// ewe-player live_resolve -- --ignored --nocapture`
    #[test]
    #[ignore = "network"]
    fn live_resolve() {
        let url = std::env::var("EWE_LINK").expect("EWE_LINK");
        let r = resolve(&url);
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
    }
}
