//! ewe-app-core — what ewe Files, ewe Player and ewe Viewer share on the Rust side.
//!
//! - [`theme`]: reads `$XDG_CONFIG_HOME/quickshell/theme-tokens.json` (v3) and watches
//!   its directory (atomic renames by `ewe-theme build` are picked up), emitting
//!   `theme-changed` to the webview.
//! - [`server`]: the loopback media server (`127.0.0.1`, a random port, a per-run token):
//!   `/raw/<name>?path=&t=` with HTTP Range streaming, `/thumb?path=&size=&t=`,
//!   `/cover?path=&t=`, `/text/<name>?path=&t=` (any encoding → UTF-8) and
//!   `/picture/<name>?path=&t=` (HEIC → JPEG), `/app-icon?path=&t=` (an eep card's
//!   icon); 403 without the token. WebKitGTK media
//!   needs real Range streaming, so files never travel through a custom scheme.
//! - [`thumbs`]: the freedesktop thumbnail cache, read and written per the spec.
//! - [`text`]: bytes in any encoding → text (BOM, UTF-8, chardetng + encoding_rs).
//! - [`picture`]: HEIC/HEIF → a cached JPEG; HEIC/AVIF/JPEG XL decoded for thumbnails.
//! - [`cover`]: audio covers (embedded picture or a cover image next to the file).
//! - [`eep`]: eep app cards (`<Name>.eep`): the app's name and embedded icon.
//! - [`recent`]: appends to `recently-used.xbel` the way GTK does.
//! - [`mime`]: content types and applications through GIO.
//! - [`launch`]: argv → paths and flags (`--version` prints JSON and exits 0).
//! - [`app`]: the Tauri builder every app runs through (single instance, app_id,
//!   media server, theme watcher, one window, quit when it closes).
//!
//! The Tauri commands live in [`commands`] and are re-exported at the crate root
//! so `tauri::generate_handler![ewe_app_core::theme_tokens, …]` resolves their
//! hidden macros; the [`handler!`] macro lists them all for an app.

pub mod app;
pub mod commands;
pub mod cover;
pub mod eep;
pub mod exif;
pub mod launch;
pub mod mime;
pub mod picture;
pub mod recent;
pub mod server;
pub mod text;
pub mod theme;
pub mod thumbs;
pub mod xdg;

pub use app::{
    AppSpec, ConfigureHook, RunHooks, SecondLaunchHook, SetupHook, open_window, run, run_with,
};
pub use commands::{
    add_recent, app_version, apps_for, default_app, launch_args, launch_with, media_server,
    mime_of, set_default_app, theme_tokens,
};

/// `tauri::generate_handler!` with every core command first, then the app's own:
///
/// ```ignore
/// ewe_app_core::run(SPEC, tauri::generate_context!(), ewe_app_core::handler![my_command]);
/// ```
#[macro_export]
macro_rules! handler {
    ($($extra:path),* $(,)?) => {
        ::tauri::generate_handler![
            $crate::theme_tokens,
            $crate::media_server,
            $crate::launch_args,
            $crate::app_version,
            $crate::add_recent,
            $crate::mime_of,
            $crate::apps_for,
            $crate::default_app,
            $crate::set_default_app,
            $crate::launch_with,
            $($extra),*
        ]
    };
}
