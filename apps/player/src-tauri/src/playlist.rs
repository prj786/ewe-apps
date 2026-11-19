//! M3U / M3U8 playlists: `#EXTM3U`, `#EXTINF:<seconds>,<title>` lines, paths relative to
//! the playlist, `file://` URIs and remote URLs.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    /// absolute path, or the URL for a stream
    pub path: String,
    pub title: Option<String>,
    pub duration: Option<f64>,
}

fn is_url(text: &str) -> bool {
    text.split_once("://")
        .map(|(scheme, rest)| {
            !rest.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .unwrap_or(false)
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn parse_m3u(text: &str, base_dir: &Path) -> Vec<PlaylistEntry> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut out = Vec::new();
    let mut pending_title: Option<String> = None;
    let mut pending_duration: Option<f64> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(info) = line.strip_prefix("#EXTINF:") {
            let (dur, title) = info.split_once(',').unwrap_or((info, ""));
            // "#EXTINF:123 tvg-id=x,Title" — attributes after the number are ignored
            let dur_text = dur.split_whitespace().next().unwrap_or("");
            pending_duration = dur_text.parse::<f64>().ok().filter(|d| *d > 0.0);
            let title = title.trim();
            pending_title = (!title.is_empty()).then(|| title.to_string());
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let path = if let Some(rest) = line.strip_prefix("file://") {
            let p = rest.strip_prefix("localhost").unwrap_or(rest);
            percent_encoding::percent_decode_str(p)
                .decode_utf8_lossy()
                .into_owned()
        } else if is_url(line) {
            line.to_string()
        } else {
            let candidate = if line.contains('\\') && !line.contains('/') {
                line.replace('\\', "/")
            } else {
                line.to_string()
            };
            let p = Path::new(&candidate);
            if p.is_absolute() {
                candidate
            } else {
                normalize(&base_dir.join(p)).to_string_lossy().into_owned()
            }
        };
        out.push(PlaylistEntry {
            path,
            title: pending_title.take(),
            duration: pending_duration.take(),
        });
    }
    out
}

/// Entries under the playlist's folder are written relative to it (portable), others absolute.
pub fn write_m3u(entries: &[PlaylistEntry], base_dir: &Path) -> String {
    let mut out = String::from("#EXTM3U\n");
    for e in entries {
        let dur = e
            .duration
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(|d| d.round() as i64)
            .unwrap_or(-1);
        let title = e.title.clone().unwrap_or_else(|| {
            Path::new(&e.path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        out.push_str(&format!("#EXTINF:{dur},{title}\n"));
        let path = if is_url(&e.path) {
            e.path.clone()
        } else {
            match Path::new(&e.path).strip_prefix(base_dir) {
                Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().into_owned(),
                _ => e.path.clone(),
            }
        };
        out.push_str(&path);
        out.push('\n');
    }
    out
}

pub fn load(path: &Path) -> std::io::Result<Vec<PlaylistEntry>> {
    let bytes = std::fs::read(path)?;
    let text = crate::subs::decode(&bytes);
    let base = path.parent().unwrap_or(Path::new("/"));
    Ok(parse_m3u(&text, base))
}

pub fn save(path: &Path, entries: &[PlaylistEntry]) -> std::io::Result<()> {
    let base = path.parent().unwrap_or(Path::new("/"));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, write_m3u(entries, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_extended_and_plain_m3u() {
        let text = "\u{FEFF}#EXTM3U\n#EXTINF:123,Sample Band - Morning Dew\n01 Morning Dew.flac\n\n#EXTINF:-1 tvg-id=\"x\",Live radio\nhttps://radio.example/stream.m3u8\n# a comment\n../Other/song.mp3\nfile:///home/me/Music/a%20b.opus\nC:\\Music\\win.mp3\n/abs/path.mp3\n";
        let got = parse_m3u(text, Path::new("/home/me/Music/Album"));
        assert_eq!(
            got,
            vec![
                PlaylistEntry {
                    path: "/home/me/Music/Album/01 Morning Dew.flac".into(),
                    title: Some("Sample Band - Morning Dew".into()),
                    duration: Some(123.0),
                },
                PlaylistEntry {
                    path: "https://radio.example/stream.m3u8".into(),
                    title: Some("Live radio".into()),
                    duration: None,
                },
                PlaylistEntry {
                    path: "/home/me/Music/Other/song.mp3".into(),
                    title: None,
                    duration: None,
                },
                PlaylistEntry {
                    path: "/home/me/Music/a b.opus".into(),
                    title: None,
                    duration: None,
                },
                PlaylistEntry {
                    path: "/home/me/Music/Album/C:/Music/win.mp3".into(),
                    title: None,
                    duration: None,
                },
                PlaylistEntry {
                    path: "/abs/path.mp3".into(),
                    title: None,
                    duration: None,
                },
            ]
        );
    }

    #[test]
    fn writes_relative_paths_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let list = dir.path().join("Playlists").join("Mix.m3u");
        let inside = dir.path().join("Playlists").join("x").join("Song One.flac");
        let entries = vec![
            PlaylistEntry {
                path: inside.to_string_lossy().into_owned(),
                title: Some("Song One".into()),
                duration: Some(200.4),
            },
            PlaylistEntry {
                path: "/elsewhere/Two.mp3".into(),
                title: None,
                duration: None,
            },
            PlaylistEntry {
                path: "https://example.com/live.m3u8".into(),
                title: Some("Live".into()),
                duration: None,
            },
        ];
        save(&list, &entries).unwrap();
        let text = std::fs::read_to_string(&list).unwrap();
        assert_eq!(
            text,
            "#EXTM3U\n#EXTINF:200,Song One\nx/Song One.flac\n#EXTINF:-1,Two\n/elsewhere/Two.mp3\n#EXTINF:-1,Live\nhttps://example.com/live.m3u8\n"
        );
        let back = load(&list).unwrap();
        assert_eq!(back[0].path, inside.to_string_lossy());
        assert_eq!(back[0].duration, Some(200.0));
        assert_eq!(back[1].title, Some("Two".into()));
        assert_eq!(back[2].path, "https://example.com/live.m3u8");
    }
}
