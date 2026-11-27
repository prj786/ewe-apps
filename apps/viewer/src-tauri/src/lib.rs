//! ewe Viewer — the window. Everything shared with the other ewe apps (theme, media
//! server, thumbnails, recent files, mime + apps, single instance) is ewe-app-core;
//! `commands.rs` holds what only the viewer needs (page memory store, comics, EXIF,
//! Trash, wallpaper, clipboard, save), `comics.rs` the archive reading.

pub mod comics;
pub mod commands;

use ewe_app_core::AppSpec;

pub const SPEC: AppSpec = AppSpec {
    id: "ewe-viewer",
    name: "ewe Viewer",
    version: env!("CARGO_PKG_VERSION"),
    width: 1000.0,
    height: 700.0,
};

pub fn run() {
    ewe_app_core::run_with(
        SPEC,
        tauri::generate_context!(),
        ewe_app_core::handler![
            commands::debug_log,
            commands::store_read,
            commands::store_write,
            commands::file_stat,
            commands::folder_images,
            commands::image_info,
            commands::trash_file,
            commands::open_external,
            commands::set_wallpaper,
            commands::copy_image,
            commands::save_bytes,
            commands::comic_list,
            commands::comic_page,
            commands::recent_documents,
        ],
        ewe_app_core::RunHooks {
            configure: Some(Box::new(|builder| {
                builder.plugin(tauri_plugin_dialog::init())
            })),
            ..Default::default()
        },
    );
}
