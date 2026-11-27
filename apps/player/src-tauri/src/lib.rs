//! ewe Player — the window. Everything shared with the other ewe apps (theme, media
//! server, thumbnails, recent files, mime + apps, single instance) is ewe-app-core; what
//! is the player's own lives here: the music library scan, subtitles, M3U playlists,
//! MPRIS, the idle inhibit, ffprobe/ffmpeg helpers, web links through yt-dlp.

pub mod commands;
pub mod folder;
pub mod inhibit;
pub mod library;
pub mod links;
pub mod mpris;
pub mod playlist;
pub mod probe;
pub mod recents;
pub mod shots;
pub mod subs;
pub mod support;
pub mod userdirs;

use ewe_app_core::AppSpec;
use tauri::Manager;

pub const SPEC: AppSpec = AppSpec {
    id: "ewe-player",
    name: "ewe Player",
    version: env!("CARGO_PKG_VERSION"),
    width: 1000.0,
    height: 640.0,
};

/// The player's start-up as a plugin (the core owns `Builder::setup`): MPRIS on the bus,
/// the idle inhibitor, the library state and roots.
fn startup() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("ewe-player")
        .setup(|app, _api| {
            app.manage(library::SharedLibrary::default());
            app.manage(commands::Roots(library::roots()));
            app.manage(inhibit::Inhibitor::default());
            app.manage(mpris::Mpris::start(app.app_handle().clone()));
            Ok(())
        })
        .build()
}

/// WebKitGTK's GStreamer backend reads these before the first media element is created.
/// They must be in the environment before the WebProcess starts, so they are set here
/// (never overriding what the user exported).
///
/// - `WPE_SHELL_MEDIA_DISK_CACHE_SIZE_{BYTES,NSEC}`: the `downloadbuffer` WebKit puts
///   between the loopback server and the demuxer defaults to 100 KB / 5 s and estimates
///   buffered *time* from the download rate — at loopback speed that reads as "5 %
///   buffered" and WebKit holds the pipeline in PAUSED forever (verified on 5–20 MB
///   files; audio-only and sub-MB files escaped it). A big buffer makes it honest.
/// - `WEBKIT_GST_ENABLE_HLS_SUPPORT` / `_DASH_SUPPORT`: off by default in WebKitGTK;
///   needed for `.m3u8` / `.mpd` URLs.
fn webkit_media_env() {
    const DEFAULTS: &[(&str, &str)] = &[
        ("WPE_SHELL_MEDIA_DISK_CACHE_SIZE_BYTES", "536870912"),
        ("WPE_SHELL_MEDIA_DISK_CACHE_SIZE_NSEC", "600000000000"),
        ("WEBKIT_GST_ENABLE_HLS_SUPPORT", "1"),
        ("WEBKIT_GST_ENABLE_DASH_SUPPORT", "1"),
    ];
    for (key, value) in DEFAULTS {
        if std::env::var_os(key).is_none_or(|v| v.is_empty()) {
            // SAFETY: called from `run()` before any other thread exists (Tauri, tokio
            // and GTK start after this).
            unsafe { std::env::set_var(key, value) };
        }
    }
}

pub fn run() {
    webkit_media_env();
    ewe_app_core::run_with(
        SPEC,
        tauri::generate_context!(),
        ewe_app_core::handler![
            commands::music_library,
            commands::music_rescan,
            commands::track_info,
            commands::list_media,
            commands::subtitle_files,
            commands::subtitle_vtt,
            commands::playlist_load,
            commands::playlist_save,
            commands::probe_media,
            commands::screenshot_frame,
            commands::recent_media,
            commands::cover_art_file,
            commands::mpris_update,
            commands::inhibit_idle,
            commands::player_places,
            commands::hypr_float,
            commands::media_support,
            commands::resolve_link,
            commands::open_in_browser,
            commands::open_in_mpv,
        ],
        ewe_app_core::RunHooks {
            configure: Some(Box::new(|builder| {
                builder
                    .plugin(tauri_plugin_dialog::init())
                    .plugin(startup())
            })),
            ..Default::default()
        },
    );
}
