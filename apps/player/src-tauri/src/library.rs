//! The music library: `$EWE_MUSIC_DIR` (or `XDG_MUSIC_DIR`, or `~/Music`) walked for audio
//! files and `.m3u` playlists, tags read with lofty, the index kept as JSON in
//! `$XDG_CACHE_HOME/ewe-player/music-index.json`. A rescan reuses every entry whose
//! mtime and size did not change (what ewe Browser's `library.ts` did in Node).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

pub const MAX_DEPTH: usize = 12;
pub const MAX_TRACKS: usize = 50_000;
pub const JOBS: usize = 4;
const INDEX_VERSION: u32 = 1;

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "ogg", "oga", "opus", "wav", "m4a", "aac", "wma", "aiff", "alac", "mka",
];
pub const PLAYLIST_EXTENSIONS: &[&str] = &["m3u", "m3u8"];
const FOLDER_COVERS: &[&str] = &[
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "cover.webp",
    "Cover.jpg",
    "Cover.png",
    "folder.jpg",
    "folder.jpeg",
    "folder.png",
    "Folder.jpg",
    "Folder.png",
    "front.jpg",
    "front.png",
    "album.jpg",
    "album.png",
];

/// One song, the shape `@ewe/shared` `Track` expects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub path: String,
    /// modification time in milliseconds (JS style)
    pub mtime: f64,
    pub size: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track: Option<u32>,
    pub disc: Option<u32>,
    pub year: Option<i32>,
    pub duration: Option<f64>,
    pub genre: String,
    pub cover: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub roots: Vec<String>,
    pub tracks: Vec<Track>,
    /// `.m3u` / `.m3u8` files found under the roots
    pub playlists: Vec<String>,
    pub scanning: bool,
    pub scanned_at: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    tracks: Vec<Track>,
    #[serde(default)]
    playlists: Vec<String>,
}

/// What the app keeps in memory between commands.
#[derive(Default)]
pub struct LibraryState {
    pub tracks: Vec<Track>,
    pub playlists: Vec<String>,
    pub scanning: bool,
    pub scanned_at: Option<i64>,
    pub loaded: bool,
}

pub type SharedLibrary = Mutex<LibraryState>;

pub fn snapshot(state: &LibraryState, roots: &[PathBuf]) -> Library {
    Library {
        roots: roots
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        tracks: state.tracks.clone(),
        playlists: state.playlists.clone(),
        scanning: state.scanning,
        scanned_at: state.scanned_at,
    }
}

/// `$EWE_MUSIC_DIR`, else `XDG_MUSIC_DIR` from user-dirs.dirs, else `~/Music`.
pub fn roots() -> Vec<PathBuf> {
    if let Some(dir) = std::env::var_os("EWE_MUSIC_DIR")
        && !dir.is_empty()
    {
        return vec![PathBuf::from(dir)];
    }
    vec![crate::userdirs::user_dir("MUSIC", "Music")]
}

pub fn index_path() -> PathBuf {
    ewe_app_core::xdg::cache_home()
        .join("ewe-player")
        .join("music-index.json")
}

pub fn load_index(path: &Path) -> (Vec<Track>, Vec<String>) {
    let Ok(text) = std::fs::read(path) else {
        return (Vec::new(), Vec::new());
    };
    match serde_json::from_slice::<IndexFile>(&text) {
        Ok(f) if f.version == INDEX_VERSION => (f.tracks, f.playlists),
        _ => (Vec::new(), Vec::new()),
    }
}

pub fn save_index(path: &Path, tracks: &[Track], playlists: &[String]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = IndexFile {
        version: INDEX_VERSION,
        tracks: tracks.to_vec(),
        playlists: playlists.to_vec(),
    };
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&file)?)?;
    std::fs::rename(&tmp, path)
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_audio(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&ext_of(path).as_str())
}

fn is_playlist(path: &Path) -> bool {
    PLAYLIST_EXTENSIONS.contains(&ext_of(path).as_str())
}

fn walk(dir: &Path, depth: usize, audio: &mut Vec<PathBuf>, playlists: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || audio.len() >= MAX_TRACKS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        // follow symlinked folders too (a Music folder is often a link to a drive)
        if kind.is_dir() || (kind.is_symlink() && path.is_dir()) {
            walk(&path, depth + 1, audio, playlists);
        } else if path.is_file() {
            if is_audio(&path) {
                audio.push(path);
            } else if is_playlist(&path) {
                playlists.push(path);
            }
        }
    }
}

/// `01 - Song.flac` → `Song`; `03_Song.mp3` → `Song`.
pub fn title_from_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let trimmed = stem.trim_start_matches(|c: char| c.is_ascii_digit());
    let digits = stem.len() - trimmed.len();
    if (1..=3).contains(&digits) {
        let rest = trimmed.trim_start_matches([' ', '.', '_', '-']);
        if rest.len() < trimmed.len() && !rest.is_empty() {
            return rest.trim().to_string();
        }
    }
    stem
}

fn folder_has_cover(path: &Path) -> bool {
    path.parent()
        .map(|dir| FOLDER_COVERS.iter().any(|n| dir.join(n).is_file()))
        .unwrap_or(false)
}

/// Whole milliseconds: serde_json does not round-trip every fractional f64
/// exactly (no `float_roundtrip`), so a sub-millisecond mtime read back from
/// music-index.json differed in the last digit — `old.mtime == mtime` failed
/// and every file was re-read on every launch (and the index test flaked).
/// Integers below 2^53 survive the trip exactly.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Tags, duration and cover presence of one file (never fails: the name is the fallback).
pub fn read_track(path: &Path, mtime: f64, size: u64) -> Track {
    let mut track = Track {
        path: path.to_string_lossy().into_owned(),
        mtime,
        size,
        title: title_from_name(path),
        artist: String::new(),
        album: String::new(),
        album_artist: String::new(),
        track: None,
        disc: None,
        year: None,
        duration: None,
        genre: String::new(),
        cover: folder_has_cover(path),
    };
    let Ok(tagged) = lofty::read_from_path(path) else {
        return track;
    };
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, ItemKey};
    let duration = tagged.properties().duration().as_secs_f64();
    if duration > 0.0 {
        track.duration = Some(duration);
    }
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return track;
    };
    let clean = |s: Option<std::borrow::Cow<'_, str>>| {
        s.map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_default()
    };
    let title = clean(tag.title());
    if !title.is_empty() {
        track.title = title;
    }
    track.artist = clean(tag.artist());
    track.album = clean(tag.album());
    track.genre = clean(tag.genre());
    track.album_artist = tag
        .get_string(&ItemKey::AlbumArtist)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    track.track = tag.track();
    track.disc = tag.disk();
    track.year = tag
        .year()
        .map(|y| y as i32)
        .or_else(|| year_from(tag.get_string(&ItemKey::RecordingDate)))
        .or_else(|| year_from(tag.get_string(&ItemKey::OriginalReleaseDate)));
    if !tag.pictures().is_empty() {
        track.cover = true;
    }
    track
}

fn year_from(text: Option<&str>) -> Option<i32> {
    let t = text?.trim();
    let digits: String = t.chars().take(4).collect();
    if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_digit()) {
        digits.parse().ok()
    } else {
        None
    }
}

/// Walk the roots and read what changed; `known` entries with the same mtime and size
/// are kept as they are. Returns the new track list and the playlists found.
pub fn scan(roots: &[PathBuf], known: &[Track]) -> (Vec<Track>, Vec<String>) {
    let mut files = Vec::new();
    let mut playlists = Vec::new();
    for root in roots {
        walk(root, 0, &mut files, &mut playlists);
    }
    let by_path: std::collections::HashMap<&str, &Track> =
        known.iter().map(|t| (t.path.as_str(), t)).collect();
    let next = std::sync::Mutex::new(Vec::with_capacity(files.len()));
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..JOBS.min(files.len().max(1)) {
            scope.spawn(|| {
                loop {
                    let i = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(path) = files.get(i) else { break };
                    let Ok(meta) = std::fs::metadata(path) else {
                        continue;
                    };
                    let mtime = mtime_ms(&meta);
                    let size = meta.len();
                    let key = path.to_string_lossy();
                    let track = match by_path.get(key.as_ref()) {
                        Some(old) if old.mtime == mtime && old.size == size => (*old).clone(),
                        _ => read_track(path, mtime, size),
                    };
                    next.lock().unwrap().push(track);
                }
            });
        }
    });
    let mut tracks = next.into_inner().unwrap();
    tracks.sort_by(|a, b| a.path.cmp(&b.path));
    let playlists = playlists
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    (tracks, playlists)
}

/// Tags for files that may not be in the library (argv, playlists).
pub fn tracks_for(paths: &[String]) -> Vec<Track> {
    paths
        .iter()
        .filter_map(|p| {
            let path = Path::new(p);
            let meta = std::fs::metadata(path).ok()?;
            Some(read_track(path, mtime_ms(&meta), meta.len()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_come_from_file_names_when_untagged() {
        assert_eq!(
            title_from_name(Path::new("/m/01 - Morning Dew.flac")),
            "Morning Dew"
        );
        assert_eq!(title_from_name(Path::new("/m/03_Third.opus")), "Third");
        assert_eq!(title_from_name(Path::new("/m/12. Twelve.mp3")), "Twelve");
        assert_eq!(title_from_name(Path::new("/m/1999.mp3")), "1999");
        assert_eq!(
            title_from_name(Path::new("/m/Plain Song.mp3")),
            "Plain Song"
        );
    }

    #[test]
    fn scan_walks_reads_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let album = dir.path().join("Band").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join(".hidden").join("x.mp3"), b"nope").unwrap();
        // a real WAV with tags, written by lofty itself
        let flac = album.join("01 - Song.wav");
        write_flac(&flac, "Song", "Band", "Album");
        std::fs::write(album.join("02 untagged.mp3"), b"not really mp3").unwrap();
        std::fs::write(album.join("cover.png"), b"png?").unwrap();
        std::fs::write(dir.path().join("mix.m3u"), b"#EXTM3U\n").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"skip me").unwrap();

        let roots = vec![dir.path().to_path_buf()];
        let (tracks, playlists) = scan(&roots, &[]);
        assert_eq!(tracks.len(), 2, "{tracks:?}");
        assert_eq!(
            playlists,
            vec![dir.path().join("mix.m3u").to_string_lossy()]
        );
        let song = tracks
            .iter()
            .find(|t| t.path.ends_with("Song.wav"))
            .unwrap();
        assert_eq!(song.title, "Song");
        assert_eq!(song.artist, "Band");
        assert_eq!(song.album, "Album");
        assert_eq!(song.track, Some(1));
        assert_eq!(song.year, Some(2024));
        assert!(song.cover, "folder cover counts");
        let untagged = tracks.iter().find(|t| t.path.ends_with(".mp3")).unwrap();
        assert_eq!(untagged.title, "untagged");
        assert!(untagged.duration.is_none());
        assert!(song.duration.unwrap() > 0.05);

        // unchanged files are reused as they are, even with doctored tags
        let mut doctored = tracks.clone();
        doctored[0].title = "KEEP ME".into();
        doctored[1].title = "KEEP ME".into();
        let (again, _) = scan(&roots, &doctored);
        assert!(again.iter().all(|t| t.title == "KEEP ME"));

        // a changed size means a re-read
        std::fs::write(album.join("02 untagged.mp3"), b"longer bytes now").unwrap();
        let (third, _) = scan(&roots, &doctored);
        let re = third.iter().find(|t| t.path.ends_with(".mp3")).unwrap();
        assert_eq!(re.title, "untagged");

        // the index round-trips
        let index = dir.path().join("cache").join("music-index.json");
        save_index(&index, &third, &playlists).unwrap();
        let (loaded, lists) = load_index(&index);
        assert_eq!(loaded, third);
        assert_eq!(lists, playlists);
        assert_eq!(load_index(Path::new("/nonexistent/x.json")).0.len(), 0);
    }

    /// A real (silent) WAV with RIFF INFO tags written by lofty.
    fn write_flac(path: &Path, title: &str, artist: &str, album: &str) {
        use lofty::config::WriteOptions;
        use lofty::tag::{Accessor, ItemKey, Tag, TagExt, TagType};
        let samples: u32 = 44100 / 10; // 0.1 s of 16-bit mono silence
        let data_len = samples * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&44100u32.to_le_bytes());
        bytes.extend_from_slice(&(44100u32 * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.resize(bytes.len() + data_len as usize, 0);
        std::fs::write(path, &bytes).unwrap();
        let mut tag = Tag::new(TagType::RiffInfo);
        tag.set_title(title.into());
        tag.set_artist(artist.into());
        tag.set_album(album.into());
        tag.set_track(1);
        tag.insert_text(ItemKey::RecordingDate, "2024-05-01".into());
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }
}
