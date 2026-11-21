//! What is inside a file, for the "cannot play" message: `ffprobe` (ffmpeg ships with ewe)
//! lists the streams and their codec ids; the webview turns those into plain words.

use std::process::Command;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedStream {
    /// "video" | "audio" | "subtitle" | "other"
    pub kind: String,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
}

pub fn parse_ffprobe(json: &[u8]) -> Vec<ProbedStream> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(json) else {
        return Vec::new();
    };
    v.get("streams")
        .and_then(|s| s.as_array())
        .map(|streams| {
            streams
                .iter()
                .map(|s| {
                    let kind = match s.get("codec_type").and_then(|t| t.as_str()) {
                        Some("video") => "video",
                        Some("audio") => "audio",
                        Some("subtitle") => "subtitle",
                        _ => "other",
                    };
                    // cover art inside audio files is a "video" stream flagged attached_pic
                    let attached = s
                        .pointer("/disposition/attached_pic")
                        .and_then(|d| d.as_i64())
                        .unwrap_or(0)
                        == 1;
                    let tag = |k: &str| {
                        s.pointer(&format!("/tags/{k}"))
                            .and_then(|t| t.as_str())
                            .map(str::to_string)
                    };
                    ProbedStream {
                        kind: if attached {
                            "other".into()
                        } else {
                            kind.into()
                        },
                        codec: s
                            .get("codec_name")
                            .and_then(|c| c.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        language: tag("language"),
                        title: tag("title"),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Run ffprobe on a path or URL (10 s cap for a file, 5 s for a link — the error page waits
/// for it). Err when ffprobe is not installed.
pub fn probe(target: &str) -> Result<Vec<ProbedStream>, String> {
    let remote = crate::links::is_web(target);
    let mut cmd = Command::new("ffprobe");
    cmd.args(["-v", "error", "-print_format", "json", "-show_streams"]);
    if remote {
        // a stalled server must not hold the read past the cap (microseconds)
        cmd.args(["-rw_timeout", "4000000"]);
    }
    let mut child = cmd
        .args(["-i", target])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("ffprobe: {e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(if remote { 5 } else { 10 });
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(out) = stdout.as_mut() {
            let _ = std::io::Read::read_to_end(out, &mut buf);
        }
        buf
    });
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("ffprobe took too long".into());
            }
        }
    }
    let out = reader.join().unwrap_or_default();
    Ok(parse_ffprobe(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_streams_and_drops_cover_art() {
        let json = br#"{"streams":[
          {"codec_type":"video","codec_name":"wmv2"},
          {"codec_type":"audio","codec_name":"wmav2","tags":{"language":"eng","title":"English"}},
          {"codec_type":"subtitle","codec_name":"subrip"},
          {"codec_type":"video","codec_name":"png","disposition":{"attached_pic":1}}
        ]}"#;
        let got = parse_ffprobe(json);
        assert_eq!(got.len(), 4);
        assert_eq!(got[0].kind, "video");
        assert_eq!(got[0].codec, "wmv2");
        assert_eq!(got[1].language.as_deref(), Some("eng"));
        assert_eq!(got[1].title.as_deref(), Some("English"));
        assert_eq!(got[2].kind, "subtitle");
        assert_eq!(got[3].kind, "other");
        assert!(parse_ffprobe(b"not json").is_empty());
    }
}
