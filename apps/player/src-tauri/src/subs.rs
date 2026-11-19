//! Subtitles: sidecar files found by name, and SRT / ASS / SSA turned into WebVTT, the
//! only format `<track>` takes.

use std::path::{Path, PathBuf};

pub const EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ssa", "sub"];

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// `Movie.srt`, `Movie.en.srt`, `Movie.forced.ass` … next to `Movie.mkv`, sorted by name.
pub fn sidecars(video: &Path) -> Vec<PathBuf> {
    let Some(dir) = video.parent() else {
        return Vec::new();
    };
    let Some(stem) = video
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
    else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && EXTENSIONS.contains(&ext_of(p).as_str()))
        .filter(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase().starts_with(&stem))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

/// Bytes → text: UTF-8 (BOM dropped) or, failing that, Windows-1252-ish Latin-1.
pub fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Read a subtitle file and return WebVTT.
pub fn to_vtt(path: &Path) -> std::io::Result<String> {
    let text = decode(&std::fs::read(path)?);
    Ok(match ext_of(path).as_str() {
        "vtt" => ensure_vtt_header(&text),
        "ass" | "ssa" => ass_to_vtt(&text),
        _ => srt_to_vtt(&text),
    })
}

fn ensure_vtt_header(text: &str) -> String {
    let t = text.replace("\r\n", "\n");
    if t.starts_with("WEBVTT") {
        t
    } else {
        format!("WEBVTT\n\n{t}")
    }
}

/// `&` that does not start an entity, and bare `<` that is not one of the VTT tags.
fn escape_cue_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '&' => {
                let rest: String = chars[i..].iter().take(10).collect();
                let entity = rest
                    .find(';')
                    .map(|end| {
                        rest[1..end]
                            .chars()
                            .all(|x| x.is_ascii_alphanumeric() || x == '#')
                    })
                    .unwrap_or(false);
                out.push_str(if entity { "&" } else { "&amp;" });
            }
            '<' => {
                let rest: String = chars[i..].iter().collect();
                if let Some(end) = rest.find('>') {
                    let tag = &rest[1..end];
                    let name = tag.trim_start_matches('/');
                    let keep = matches!(name, "i" | "b" | "u") || name.starts_with("c.");
                    if keep {
                        out.push_str(&rest[..=end]);
                        i += end + 1;
                        continue;
                    }
                    if name.starts_with("font") || name == "br" || name.starts_with("span") {
                        // dropped: VTT has no colours or breaks in tags (a break is a newline)
                        if name == "br" {
                            out.push('\n');
                        }
                        i += end + 1;
                        continue;
                    }
                }
                out.push_str("&lt;");
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// `00:01:02,345` (SRT; `.` and a missing hour are tolerated) → `00:01:02.345`.
fn parse_srt_time(text: &str) -> Option<f64> {
    let t = text.trim().replace(',', ".");
    let parts: Vec<&str> = t.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m, s] => (
            h.parse::<f64>().ok()?,
            m.parse::<f64>().ok()?,
            s.parse::<f64>().ok()?,
        ),
        [m, s] => (0.0, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + s)
}

pub fn vtt_time(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let h = total_ms / 3_600_000;
    let m = (total_ms % 3_600_000) / 60_000;
    let s = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

struct Cue {
    start: f64,
    end: f64,
    settings: String,
    text: String,
}

fn render(cues: &[Cue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (i, cue) in cues.iter().enumerate() {
        out.push_str(&format!("{}\n", i + 1));
        out.push_str(&vtt_time(cue.start));
        out.push_str(" --> ");
        out.push_str(&vtt_time(cue.end.max(cue.start + 0.001)));
        if !cue.settings.is_empty() {
            out.push(' ');
            out.push_str(&cue.settings);
        }
        out.push('\n');
        out.push_str(cue.text.trim_end());
        out.push_str("\n\n");
    }
    out
}

pub fn srt_to_vtt(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues: Vec<Cue> = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((a, b)) = line.split_once("-->") else {
            continue;
        };
        // "00:00:01,000 --> 00:00:04,000 X1:40 X2:600" — positions after the end are dropped
        let end_text = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_srt_time(a), parse_srt_time(end_text)) else {
            continue;
        };
        let mut body = Vec::new();
        for l in lines.by_ref() {
            if l.trim().is_empty() {
                break;
            }
            body.push(l);
        }
        let joined = body.join("\n");
        // SRT "{\an8}" (top) crept in from ASS; honour it
        let (settings, joined) = if joined.contains("{\\an8}") {
            ("line:5%".to_string(), joined.replace("{\\an8}", ""))
        } else {
            (String::new(), joined)
        };
        cues.push(Cue {
            start,
            end,
            settings,
            text: escape_cue_text(&joined),
        });
    }
    cues.sort_by(|x, y| x.start.total_cmp(&y.start));
    render(&cues)
}

/// `0:01:02.34` → seconds.
fn parse_ass_time(text: &str) -> Option<f64> {
    parse_srt_time(text)
}

/// `{\b1}bold{\b0} line\Nnext` → `<b>bold</b> line\nnext`; other overrides are dropped.
fn ass_text_to_vtt(text: &str) -> (String, String) {
    let mut out = String::new();
    let mut settings = String::new();
    let mut rest = text;
    let mut open: Vec<&str> = Vec::new();
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let block = &after[..end];
        for tag in block.split('\\').filter(|t| !t.is_empty()) {
            match tag {
                "i1" if !open.contains(&"i") => {
                    out.push_str("<i>");
                    open.push("i");
                }
                "b1" if !open.contains(&"b") => {
                    out.push_str("<b>");
                    open.push("b");
                }
                "u1" if !open.contains(&"u") => {
                    out.push_str("<u>");
                    open.push("u");
                }
                "i0" | "b0" | "u0" => {
                    let name = &tag[..1];
                    if let Some(pos) = open.iter().position(|t| *t == name) {
                        open.remove(pos);
                        out.push_str(&format!("</{name}>"));
                    }
                }
                t if t.starts_with("an") => {
                    if matches!(t, "an7" | "an8" | "an9") {
                        settings = "line:5%".into();
                    } else if matches!(t, "an4" | "an5" | "an6") {
                        settings = "line:50%".into();
                    }
                }
                _ => {}
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    for name in open.iter().rev() {
        out.push_str(&format!("</{name}>"));
    }
    let out = out
        .replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ");
    (settings, out)
}

pub fn ass_to_vtt(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut in_events = false;
    let mut format: Vec<String> = Vec::new();
    let mut cues: Vec<Cue> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_events = trimmed.eq_ignore_ascii_case("[events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(f) = trimmed.strip_prefix("Format:") {
            format = f.split(',').map(|s| s.trim().to_lowercase()).collect();
            continue;
        }
        let Some(d) = trimmed.strip_prefix("Dialogue:") else {
            continue;
        };
        let columns = if format.is_empty() {
            vec![
                "layer", "start", "end", "style", "name", "marginl", "marginr", "marginv",
                "effect", "text",
            ]
            .into_iter()
            .map(String::from)
            .collect()
        } else {
            format.clone()
        };
        let fields: Vec<&str> = d.splitn(columns.len(), ',').map(|s| s.trim()).collect();
        let get = |name: &str| {
            columns
                .iter()
                .position(|c| c == name)
                .and_then(|i| fields.get(i).copied())
        };
        let (Some(start), Some(end), Some(body)) = (get("start"), get("end"), get("text")) else {
            continue;
        };
        let (Some(start), Some(end)) = (parse_ass_time(start), parse_ass_time(end)) else {
            continue;
        };
        let (settings, body) = ass_text_to_vtt(body);
        cues.push(Cue {
            start,
            end,
            settings,
            text: escape_cue_text(&body),
        });
    }
    cues.sort_by(|x, y| x.start.total_cmp(&y.start));
    render(&cues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_becomes_vtt() {
        let srt = "\u{FEFF}1\r\n00:00:00,500 --> 00:00:03,000\r\nHere comes the sun.\r\n\r\n2\r\n00:00:03,500 --> 00:00:08,000 X1:40\r\n<i>Line two,</i> with <b>style</b>\r\nand a second line & <font color=\"#ff0000\">red</font>.\r\n\r\n3\r\n00:01:09,000 --> 00:01:14,000\r\n{\\an8}Up top &amp; fine\r\n";
        let vtt = srt_to_vtt(srt);
        assert_eq!(
            vtt,
            "WEBVTT\n\n1\n00:00:00.500 --> 00:00:03.000\nHere comes the sun.\n\n2\n00:00:03.500 --> 00:00:08.000\n<i>Line two,</i> with <b>style</b>\nand a second line &amp; red.\n\n3\n00:01:09.000 --> 00:01:14.000 line:5%\nUp top &amp; fine\n\n"
        );
    }

    #[test]
    fn ass_becomes_vtt() {
        let ass = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:09.50,Default,,0,0,0,,{\\pos(100,100)}Positioned {\\i1}italic{\\i0} text, with a comma\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\b1}ASS{\\b0} first line\\Nsecond line\nDialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,{\\an8\\i1}top and italic to the end\n";
        let vtt = ass_to_vtt(ass);
        assert_eq!(
            vtt,
            "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<b>ASS</b> first line\nsecond line\n\n2\n00:00:05.000 --> 00:00:09.500\nPositioned <i>italic</i> text, with a comma\n\n3\n00:00:10.000 --> 00:00:12.000 line:5%\n<i>top and italic to the end</i>\n\n"
        );
    }

    #[test]
    fn decodes_latin1_and_finds_sidecars() {
        assert_eq!(decode(b"caf\xE9"), "café");
        assert_eq!(decode("\u{FEFF}ok".as_bytes()), "ok");
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Movie Night.mkv");
        for n in [
            "Movie Night.mkv",
            "Movie Night.srt",
            "Movie Night.en.vtt",
            "movie night.de.forced.ass",
            "Other.srt",
            "Movie Night.txt",
        ] {
            std::fs::write(dir.path().join(n), b"x").unwrap();
        }
        let found: Vec<String> = sidecars(&video)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            found,
            vec![
                "Movie Night.en.vtt",
                "Movie Night.srt",
                "movie night.de.forced.ass"
            ]
        );
        std::fs::write(
            dir.path().join("plain.vtt"),
            b"00:00.000 --> 00:01.000\nhi\n",
        )
        .unwrap();
        assert!(
            to_vtt(&dir.path().join("plain.vtt"))
                .unwrap()
                .starts_with("WEBVTT\n\n00:00")
        );
    }
}
