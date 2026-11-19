//! What is playable in a folder (the playlist panel's "folder siblings", folders on argv).

use std::path::Path;

use serde::Serialize;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "m2ts", "ogv",
    "ts", "vob", "asf", "divx",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub kind: &'static str,
}

fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some("video")
    } else if crate::library::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        Some("audio")
    } else {
        None
    }
}

/// Media files directly inside `dir` (not hidden), unsorted: the webview sorts naturally.
pub fn media_in(dir: &Path) -> Vec<MediaFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && !p
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with('.'))
                    .unwrap_or(true)
        })
        .filter_map(|p| {
            kind_of(&p).map(|kind| MediaFile {
                path: p.to_string_lossy().into_owned(),
                kind,
            })
        })
        .collect()
}

/// Files stay files (when they are media); folders become their media children.
pub fn expand(paths: &[String]) -> Vec<MediaFile> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            let mut inner = media_in(path);
            inner.sort_by(|a, b| a.path.cmp(&b.path));
            out.extend(inner);
        } else if let Some(kind) = kind_of(path) {
            out.push(MediaFile {
                path: p.clone(),
                kind,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_folders_and_keeps_media_files() {
        let dir = tempfile::tempdir().unwrap();
        for n in ["b.mkv", "a.MP4", "song.flac", ".hidden.mp4", "notes.txt"] {
            std::fs::write(dir.path().join(n), b"x").unwrap();
        }
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let d = dir.path().to_string_lossy().into_owned();
        let got = expand(&[d.clone(), format!("{d}/notes.txt"), format!("{d}/b.mkv")]);
        let names: Vec<(String, &str)> = got
            .iter()
            .map(|m| (m.path.rsplit('/').next().unwrap().to_string(), m.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                ("a.MP4".to_string(), "video"),
                ("b.mkv".to_string(), "video"),
                ("song.flac".to_string(), "audio"),
                ("b.mkv".to_string(), "video"),
            ]
        );
    }
}
