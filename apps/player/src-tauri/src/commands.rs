//! The player's own Tauri commands (the core's are in `ewe_app_core::handler!`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::folder::MediaFile;
use crate::inhibit::Inhibitor;
use crate::library::{Library, SharedLibrary, Track};
use crate::mpris::{Mpris, MprisUpdate};
use crate::playlist::PlaylistEntry;
use crate::probe::ProbedStream;
use crate::recents::RecentItem;

/// Where the library lives (one place to override in tests).
pub struct Roots(pub Vec<PathBuf>);

fn snapshot(state: &State<'_, SharedLibrary>, roots: &State<'_, Roots>) -> Library {
    let lib = state.lock().unwrap();
    crate::library::snapshot(&lib, &roots.0)
}

fn start_scan(app: AppHandle, roots: Vec<PathBuf>) {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<SharedLibrary>();
        let known = state.lock().unwrap().tracks.clone();
        let (tracks, playlists) = crate::library::scan(&roots, &known);
        let index = crate::library::index_path();
        if let Err(e) = crate::library::save_index(&index, &tracks, &playlists) {
            eprintln!("ewe-player: could not write {}: {e}", index.display());
        }
        let snap = {
            let mut lib = state.lock().unwrap();
            lib.tracks = tracks;
            lib.playlists = playlists;
            lib.scanning = false;
            lib.scanned_at = Some(chrono::Utc::now().timestamp_millis());
            crate::library::snapshot(&lib, &roots)
        };
        let _ = app.emit("music-changed", snap);
    });
}

/// The library as last indexed; the first call loads the index and starts a scan,
/// whose result arrives as the `music-changed` event.
#[tauri::command]
pub fn music_library(
    app: AppHandle,
    state: State<'_, SharedLibrary>,
    roots: State<'_, Roots>,
) -> Library {
    let mut kick = false;
    {
        let mut lib = state.lock().unwrap();
        if !lib.loaded {
            let (tracks, playlists) = crate::library::load_index(&crate::library::index_path());
            lib.tracks = tracks;
            lib.playlists = playlists;
            lib.loaded = true;
            if !lib.scanning {
                lib.scanning = true;
                kick = true;
            }
        }
    }
    if kick {
        start_scan(app, roots.0.clone());
    }
    snapshot(&state, &roots)
}

#[tauri::command]
pub fn music_rescan(
    app: AppHandle,
    state: State<'_, SharedLibrary>,
    roots: State<'_, Roots>,
) -> Library {
    let kick = {
        let mut lib = state.lock().unwrap();
        lib.loaded = true;
        if lib.scanning {
            false
        } else {
            lib.scanning = true;
            true
        }
    };
    if kick {
        start_scan(app, roots.0.clone());
    }
    snapshot(&state, &roots)
}

/// Tags of files that may not be in the library (argv, playlists, drops).
#[tauri::command]
pub async fn track_info(paths: Vec<String>) -> Vec<Track> {
    tauri::async_runtime::spawn_blocking(move || crate::library::tracks_for(&paths))
        .await
        .unwrap_or_default()
}

/// Media files for paths: files stay, folders expand to their media children.
#[tauri::command]
pub async fn list_media(paths: Vec<String>) -> Vec<MediaFile> {
    tauri::async_runtime::spawn_blocking(move || crate::folder::expand(&paths))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn subtitle_files(video: String) -> Vec<String> {
    crate::subs::sidecars(Path::new(&video))
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// A subtitle file as WebVTT text (SRT / ASS / SSA converted).
#[tauri::command]
pub async fn subtitle_vtt(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::subs::to_vtt(Path::new(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn playlist_load(path: String) -> Result<Vec<PlaylistEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::playlist::load(Path::new(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn playlist_save(path: String, entries: Vec<PlaylistEntry>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::playlist::save(Path::new(&path), &entries).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streams and codecs of a file or URL (ffprobe); Err when ffprobe is missing.
#[tauri::command]
pub async fn probe_media(target: String) -> Result<Vec<ProbedStream>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::probe::probe(&target))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub path: String,
    pub name: String,
}

/// Save the frame at `time` of `path` to ~/Pictures/Screenshots.
#[tauri::command]
pub async fn screenshot_frame(path: String, time: f64) -> Result<Saved, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::shots::grab(Path::new(&path), time).map(|p| Saved {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: p.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recent_media() -> Vec<RecentItem> {
    tauri::async_runtime::spawn_blocking(|| crate::recents::read("ewe Player"))
        .await
        .unwrap_or_default()
}

/// Album art as a `file://` URL for MPRIS (the dock, playerctl): the embedded picture
/// or folder cover written once to `$XDG_CACHE_HOME/ewe-player/art/<hash>`.
#[tauri::command]
pub async fn cover_art_file(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let cover = ewe_app_core::cover::find(p)?;
        let ext = match cover.mime.as_str() {
            "image/png" => "png",
            "image/webp" => "webp",
            _ => "jpg",
        };
        let hash = {
            use md5::Digest;
            hex::encode(md5::Md5::digest(path.as_bytes()))
        };
        let dir = ewe_app_core::xdg::cache_home()
            .join("ewe-player")
            .join("art");
        std::fs::create_dir_all(&dir).ok()?;
        let file = dir.join(format!("{hash}.{ext}"));
        let fresh = std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .zip(std::fs::metadata(p).and_then(|m| m.modified()).ok())
            .map(|(art, src)| art >= src)
            .unwrap_or(false);
        if !fresh {
            std::fs::write(&file, &cover.bytes).ok()?;
        }
        Some(ewe_app_core::xdg::file_uri(&file))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub fn mpris_update(mpris: State<'_, Mpris>, update: MprisUpdate) {
    mpris.update(update);
}

/// Keep the screen awake (true) or let it sleep again (false).
#[tauri::command]
pub async fn inhibit_idle(inhibitor: State<'_, Inhibitor>, on: bool) -> Result<bool, String> {
    inhibitor.set(on).await
}

/// Where the music library and the playlists folder are (for dialogs' start folders).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub music: String,
    pub videos: String,
    pub playlists: String,
    pub screenshots: String,
}

#[tauri::command]
pub fn player_places(roots: State<'_, Roots>) -> Places {
    let music = roots
        .0
        .first()
        .cloned()
        .unwrap_or_else(|| crate::userdirs::user_dir("MUSIC", "Music"));
    Places {
        playlists: music.join("Playlists").to_string_lossy().into_owned(),
        music: music.to_string_lossy().into_owned(),
        videos: crate::userdirs::user_dir("VIDEOS", "Videos")
            .to_string_lossy()
            .into_owned(),
        screenshots: crate::shots::screenshots_dir()
            .to_string_lossy()
            .into_owned(),
    }
}
