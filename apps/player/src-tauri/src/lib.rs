//! ewe Player — the window. Everything shared with the other ewe apps (theme, media
//! server, thumbnails, recent files, mime + apps, single instance) is ewe-app-core; what
//! is the player's own lives here: the music library scan, subtitles, M3U playlists,
//! MPRIS, the idle inhibit, ffprobe/ffmpeg helpers.

pub mod commands;
pub mod folder;
pub mod inhibit;
pub mod library;
pub mod mpris;
pub mod playlist;
pub mod probe;
pub mod recents;
pub mod shots;
pub mod subs;
pub mod userdirs;

use ewe_app_core::AppSpec;
use tauri::Manager;

pub const SPEC: AppSpec = AppSpec {
    id: "ewe-player",
    name: "ewe Player",
    version: env!("CARGO_PKG_VERSION"),
    width: 1000.0,
    height: 640.0,
    min_width: 480.0,
    min_height: 320.0,
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

pub fn run() {
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
        ],
        |builder| {
            builder
                .plugin(tauri_plugin_dialog::init())
                .plugin(startup())
        },
    );
}
