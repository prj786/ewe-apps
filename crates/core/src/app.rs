//! The Tauri builder the three apps share.

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::AppIdentity;
use crate::launch::Launch;

/// What differs between ewe Files, ewe Player and ewe Viewer at start-up.
#[derive(Debug, Clone)]
pub struct AppSpec {
    /// the binary name = Wayland app_id = `StartupWMClass`, e.g. `ewe-viewer`
    pub id: &'static str,
    /// the product name shown in the title, e.g. `ewe Viewer`
    pub name: &'static str,
    pub version: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// Run the app. Handles `--version` (JSON, exit 0), sets the app_id before GTK
/// starts, forwards a second launch's argv as the `launch` event, starts the media
/// server and the theme watcher, opens the one window and exits when it closes.
///
/// `handler` is `ewe_app_core::handler![…]` (the core's commands plus the app's own).
pub fn run<F>(spec: AppSpec, context: tauri::Context<tauri::Wry>, handler: F)
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    let cwd = std::env::current_dir().unwrap_or_else(|_| "/".into());
    let launch = Launch::parse(std::env::args().skip(1), &cwd);
    if launch.wants_version() {
        println!(
            "{}",
            serde_json::json!({ "ok": true, "name": spec.id, "product": spec.name, "version": spec.version })
        );
        std::process::exit(0);
    }
    // The Wayland app_id is GTK's program name; it must be set before GTK starts.
    glib::set_prgname(Some(spec.id));

    let identity = AppIdentity {
        id: spec.id,
        name: spec.name,
        version: spec.version,
    };
    let title = spec.name.to_string();
    let (w, h, mw, mh) = (spec.width, spec.height, spec.min_width, spec.min_height);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let launch = Launch::parse(argv.into_iter().skip(1), std::path::Path::new(&cwd));
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("launch", launch);
        }))
        .manage(identity)
        .manage(launch)
        .setup(move |app| {
            let thumbs = crate::thumbs::Thumbs::new(crate::thumbs::Thumbs::default_root());
            let server = crate::server::start(thumbs)?;
            // for tests and tools (scripts/shot.sh): where the server is, as JSON, 0600
            if let Some(file) = std::env::var_os("EWE_APPS_MEDIA_SERVER_FILE")
                && !file.is_empty()
            {
                write_private(
                    std::path::Path::new(&file),
                    &serde_json::to_vec(&server.info)?,
                )?;
            }
            app.manage(server.info);

            let handle = app.handle().clone();
            let watch = crate::theme::watch(crate::theme::tokens_path(), move |tokens| {
                let _ = handle.emit("theme-changed", tokens);
            });
            if let Some(watch) = watch {
                app.manage(watch);
            }

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&title)
                .inner_size(w, h)
                .min_inner_size(mw, mh)
                .decorations(false)
                .build()?;
            Ok(())
        })
        .invoke_handler(handler)
        .run(context)
        .expect("error while running the app");
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    std::io::Write::write_all(&mut f, bytes)
}
