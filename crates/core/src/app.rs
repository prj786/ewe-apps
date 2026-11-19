//! The Tauri builder the three apps share.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

/// A [`RunHooks::setup`] callback.
pub type SetupHook = Box<dyn FnOnce(&AppHandle) -> Result<(), Box<dyn std::error::Error>> + Send>;
/// A [`RunHooks::second_launch`] callback.
pub type SecondLaunchHook = Arc<dyn Fn(&AppHandle, Launch) + Send + Sync>;

/// What an app may add to the shared start-up (see [`run_with`]). Every field is
/// optional; [`run`] uses the defaults.
#[derive(Default)]
pub struct RunHooks {
    /// Called on the main thread once the media server, the theme watcher and the
    /// `main` window exist (register app state, D-Bus services, GIO monitors here).
    pub setup: Option<SetupHook>,
    /// Replaces the default answer to a second launch (focus `main`, emit `launch`):
    /// ewe Files opens a new window or tab instead.
    pub second_launch: Option<SecondLaunchHook>,
    /// Adds to the Tauri builder before it runs, for an app with Tauri plugins of its
    /// own (`Box::new(|b| b.plugin(tauri_plugin_dialog::init()))` — ewe Viewer).
    pub configure: Option<ConfigureHook>,
}

/// See [`RunHooks::configure`].
pub type ConfigureHook = Box<dyn FnOnce(tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry>>;

/// Run the app. Handles `--version` (JSON, exit 0), sets the app_id before GTK
/// starts, forwards a second launch's argv as the `launch` event, starts the media
/// server and the theme watcher, opens the one window and exits when it closes.
///
/// `handler` is `ewe_app_core::handler![…]` (the core's commands plus the app's own).
pub fn run<F>(spec: AppSpec, context: tauri::Context<tauri::Wry>, handler: F)
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    run_with(spec, context, handler, RunHooks::default());
}

/// [`run`] with app hooks (see [`RunHooks`]).
pub fn run_with<F>(spec: AppSpec, context: tauri::Context<tauri::Wry>, handler: F, hooks: RunHooks)
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
    let window_spec = spec.clone();
    let second_launch = hooks.second_launch;
    let setup = hooks.setup;
    let configure = hooks
        .configure
        .unwrap_or_else(|| Box::new(|builder| builder));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, argv, cwd| {
            let launch = Launch::parse(argv.into_iter().skip(1), std::path::Path::new(&cwd));
            match &second_launch {
                Some(hook) => hook(app, launch),
                None => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("launch", launch);
                }
            }
        }))
        .manage(identity)
        .manage(launch)
        .manage(spec);
    configure(builder)
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

            open_window(app.handle(), &window_spec, "main")?;
            if let Some(setup) = setup {
                setup(app.handle())?;
            }
            Ok(())
        })
        .invoke_handler(handler)
        .run(context)
        .expect("error while running the app");
}

/// Open another window of the app (`index.html`, undecorated, the spec's sizes).
/// The capability file must list the label (`main`, or a pattern such as `win-*`).
pub fn open_window(app: &AppHandle, spec: &AppSpec, label: &str) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(spec.name)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .decorations(false)
        .build()
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
