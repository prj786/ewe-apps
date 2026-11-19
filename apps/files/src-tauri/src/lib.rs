//! ewe Files — the window. Everything shared with the other ewe apps (theme, media
//! server, thumbnails, recent files, mime + apps, single instance) is ewe-app-core.

use ewe_app_core::AppSpec;

pub const SPEC: AppSpec = AppSpec {
    id: "ewe-files-app",
    name: "ewe Files",
    version: env!("CARGO_PKG_VERSION"),
    width: 1100.0,
    height: 700.0,
    min_width: 640.0,
    min_height: 420.0,
};

pub fn run() {
    ewe_app_core::run(SPEC, tauri::generate_context!(), ewe_app_core::handler![]);
}
