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
    /// Asked what the first window is, for a launch that wants another one than the
    /// app's usual (ewe Files' small "Install" window). `None`: the usual one.
    pub first_window: Option<FirstWindowHook>,
}

/// See [`RunHooks::first_window`].
pub type FirstWindowHook = Box<dyn FnOnce(&Launch) -> Option<WindowShape> + Send>;

/// A window that is not the app's usual one: a small card, like a dialog. Floating
/// it, and where, is the compositor's (a window rule on its first `title`).
#[derive(Debug, Clone)]
pub struct WindowShape {
    /// the title it opens with (what a compositor's window rule matches)
    pub title: String,
    pub width: f64,
    pub height: f64,
    /// `false`: the window keeps exactly this size
    pub resizable: bool,
    /// Runs in the page before its own scripts: how the page learns which view it
    /// is (`window.__eweView = "install"`), before the first paint.
    pub script: Option<String>,
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
    crate::trace::mark("main");
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
    let first_shape = hooks.first_window.and_then(|ask| ask(&launch));
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
            crate::trace::mark("setup");
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

            crate::trace::mark("services");
            let process: tauri::State<Launch> = app.state();
            match &first_shape {
                Some(shape) => open_shaped(app.handle(), "main", shape, Some(process.inner()))?,
                None => open_window(app.handle(), &window_spec, "main", Some(process.inner()))?,
            };
            if let Some(setup) = setup {
                setup(app.handle())?;
            }
            crate::trace::mark("setup-done");
            Ok(())
        })
        .invoke_handler(handler)
        .run(context)
        .expect("error while running the app");
}

/// What a window knows before its first script runs, as `window.__ewe`: the theme
/// tokens, the media server, the app's identity and — when the caller has it — what
/// this window was asked to open. The page used to ask for each over IPC, and the
/// first answers took ~45 ms to come back (measured 2026-11-23): the first folder or
/// picture waited behind them, and the first paint had the fallback colours.
fn boot_script(
    app: &AppHandle,
    theme: &Option<serde_json::Value>,
    launch: Option<&Launch>,
) -> String {
    let server = app.try_state::<crate::server::MediaServerInfo>();
    let identity = app.try_state::<AppIdentity>();
    // which of the launch's paths are folders: ewe Files opens a folder as a tab and
    // a file as its folder with the file selected, and no longer has to ask first
    let dirs: Option<Vec<bool>> = launch.map(|l| {
        l.paths
            .iter()
            .map(|p| std::path::Path::new(p).is_dir())
            .collect()
    });
    let boot = serde_json::json!({
        "theme": theme,
        "server": server.as_deref(),
        "app": identity.as_deref(),
        "launch": launch,
        "dirs": dirs,
    });
    format!("window.__ewe = {boot};")
}

/// `#rrggbb` (or `#aarrggbb`) → an opaque colour.
fn parse_colour(text: &str) -> Option<tauri::window::Color> {
    let hex = text.strip_prefix('#')?;
    let hex = match hex.len() {
        6 => hex,
        8 => &hex[2..],
        _ => return None,
    };
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some(tauri::window::Color(
        (n >> 16) as u8,
        (n >> 8) as u8,
        n as u8,
        255,
    ))
}

/// The start every window shares: undecorated, the theme's variant and page colour
/// from the first frame, the boot script — and built HIDDEN, then shown.
///
/// Hidden first is for speed, not looks. tao shows a window before it turns the
/// decorations off; on Wayland GTK then builds its own title bar for that moment and
/// loads three symbolic icons for it, and since gdk-pixbuf 2.44 an icon is decoded in
/// a sandboxed glycin loader that has to be spawned: 125 ms of every launch, for a
/// title bar nobody sees (strace, 2026-11-23). A window that is not visible yet gets
/// no title bar; `finish` shows it once tao has set it up.
fn window_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    launch: Option<&Launch>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let theme = crate::theme::read(&crate::theme::tokens_path());
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .decorations(false)
        .visible(false)
        .initialization_script(boot_script(app, &theme, launch));
    if let Some(tokens) = &theme {
        // without it tao asks the portal for the colour scheme (a D-Bus round trip)
        match tokens.pointer("/input/variant").and_then(|v| v.as_str()) {
            Some("light") => builder = builder.theme(Some(tauri::Theme::Light)),
            Some(_) => builder = builder.theme(Some(tauri::Theme::Dark)),
            None => {}
        }
        if let Some(colour) = tokens
            .pointer("/color/surface-base")
            .and_then(|v| v.as_str())
            .and_then(parse_colour)
        {
            builder = builder.background_color(colour);
        }
    }
    builder
}

fn finish(win: WebviewWindow) -> tauri::Result<WebviewWindow> {
    win.show()?;
    crate::trace::mark("window");
    Ok(win)
}

/// Open another window of the app (`index.html`, undecorated, the spec's sizes).
/// The capability file must list the label (`main`, or a pattern such as `win-*`).
/// `launch` is what this window was asked to open, when the caller knows it: the
/// page then has it before its first script (`getLaunch()`), else it asks.
pub fn open_window(
    app: &AppHandle,
    spec: &AppSpec,
    label: &str,
    launch: Option<&Launch>,
) -> tauri::Result<WebviewWindow> {
    finish(
        window_builder(app, label, launch)
            .title(spec.name)
            .inner_size(spec.width, spec.height)
            .min_inner_size(spec.min_width, spec.min_height)
            .build()?,
    )
}

/// Open a window of another shape than the app's usual one (see [`WindowShape`]).
/// The capability file must list the label, as for [`open_window`].
pub fn open_shaped(
    app: &AppHandle,
    label: &str,
    shape: &WindowShape,
    launch: Option<&Launch>,
) -> tauri::Result<WebviewWindow> {
    let mut builder = window_builder(app, label, launch)
        .title(&shape.title)
        .inner_size(shape.width, shape.height)
        .resizable(shape.resizable);
    if !shape.resizable {
        builder = builder
            .min_inner_size(shape.width, shape.height)
            .max_inner_size(shape.width, shape.height);
    }
    if let Some(script) = &shape.script {
        builder = builder.initialization_script(script);
    }
    finish(builder.build()?)
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
