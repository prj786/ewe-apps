//! ewe Files — the file manager. Everything shared with the other ewe apps (theme,
//! media server, thumbnails, recent files, mime + apps, single instance) is
//! ewe-app-core; this crate adds listing, the operations queue, Trash, archives,
//! search, devices, Properties, the FileManager1 D-Bus service and many windows.

pub mod archive;
pub mod clip;
pub mod dbus;
pub mod devices;
pub mod fs;
pub mod misc;
pub mod ops;
pub mod places;
pub mod props;
pub mod search;
pub mod trash;
pub mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use ewe_app_core::launch::Launch;
use ewe_app_core::{AppSpec, RunHooks};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub const SPEC: AppSpec = AppSpec {
    id: "ewe-files-app",
    name: "ewe Files",
    version: env!("CARGO_PKG_VERSION"),
    width: 1100.0,
    height: 700.0,
    min_width: 640.0,
    min_height: 420.0,
};

pub struct FilesState {
    pub ops: ops::Ops,
    pub watches: watch::Watches,
    pub search: search::Search,
    /// what each window was asked to open (`main` reads the process launch)
    pub launches: Mutex<HashMap<String, Launch>>,
    pub next_window: AtomicU64,
    pub next_size: AtomicU64,
    pub size_jobs: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    pub dbus: Mutex<Option<zbus::Connection>>,
    pub emit: ops::Emit,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn expand(input: &str) -> PathBuf {
    fs::expand(input, &home())
}

fn trash_env() -> trash::TrashEnv {
    trash::TrashEnv::system(&ewe_app_core::xdg::data_home())
}

fn io(e: std::io::Error) -> String {
    fs::error_message(&e)
}

/// Open a window for `launch` (a second launch, D-Bus, Ctrl+N).
pub fn open_window(app: &AppHandle, launch: Launch) -> tauri::Result<String> {
    let state: State<FilesState> = app.state();
    let n = state.next_window.fetch_add(1, Ordering::SeqCst);
    let label = format!("win-{n}");
    state.launches.lock().unwrap().insert(label.clone(), launch);
    let spec: State<AppSpec> = app.state();
    let win = ewe_app_core::open_window(app, &spec, &label)?;
    let _ = win.set_focus();
    Ok(label)
}

fn second_launch(app: &AppHandle, launch: Launch) {
    // `--tab`: a new tab in the focused (or the only) window; else a new window
    if launch.flags.iter().any(|f| f == "--tab") {
        let windows = app.webview_windows();
        let target = windows
            .values()
            .find(|w| w.is_focused().unwrap_or(false))
            .or_else(|| windows.get("main"))
            .or_else(|| windows.values().next())
            .cloned();
        if let Some(win) = target {
            let _ = win.unminimize();
            let _ = win.set_focus();
            let _ = win.emit("launch", launch);
            return;
        }
    }
    let _ = open_window(app, launch);
}

pub fn run() {
    let hooks = RunHooks {
        setup: Some(Box::new(|app| {
            let handle = app.clone();
            let emit: ops::Emit = Arc::new(move |name, payload| {
                let _ = handle.emit(name, payload);
            });
            let state = FilesState {
                ops: ops::Ops::new(emit.clone()),
                watches: watch::Watches::default(),
                search: search::Search::default(),
                launches: Mutex::new(HashMap::new()),
                next_window: AtomicU64::new(1),
                next_size: AtomicU64::new(1),
                size_jobs: Mutex::new(HashMap::new()),
                dbus: Mutex::new(None),
                emit: emit.clone(),
            };
            app.manage(state);
            devices::init(emit.clone());
            // "Show in folder" from every other app, when no other file manager holds the name
            let handle = app.clone();
            let bus_emit: ops::Emit = Arc::new(move |name, payload| {
                if name == "fm1" {
                    let kind = payload["kind"].as_str().unwrap_or("").to_string();
                    let paths: Vec<String> = payload["paths"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|p| p.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let flag = match kind.as_str() {
                        "items" => "--select",
                        "properties" => "--properties",
                        _ => "--folders",
                    };
                    let launch = Launch {
                        paths,
                        flags: vec![flag.to_string()],
                        cwd: "/".into(),
                        urls: Vec::new(),
                    };
                    let _ = open_window(&handle, launch);
                }
            });
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                match dbus::serve(bus_emit).await {
                    Ok(conn) => {
                        let state: State<FilesState> = handle.state();
                        *state.dbus.lock().unwrap() = Some(conn);
                    }
                    Err(e) => eprintln!("ewe-files-app: FileManager1 not claimed: {e}"),
                }
            });
            Ok(())
        })),
        second_launch: Some(Arc::new(second_launch)),
        configure: None,
    };
    ewe_app_core::run_with(
        SPEC,
        tauri::generate_context!(),
        ewe_app_core::handler![
            window_launch,
            new_window,
            list_dir,
            places,
            devices_list,
            device_action,
            connect_server,
            mount_reply,
            watch_dir,
            make_folder,
            make_file,
            rename_entry,
            make_link,
            templates,
            op_start,
            op_pause,
            op_resume,
            op_cancel,
            op_resolve,
            op_dismiss,
            ops_list,
            undo,
            undo_label,
            trash_list,
            archive_list,
            archive_extract,
            archive_compress,
            search_start,
            search_stop,
            search_everywhere,
            stat_path,
            chmod_path,
            folder_size_start,
            folder_size_stop,
            open_terminal,
            set_wallpaper,
            run_executable,
            komble_install,
            ewe_sync,
            tools,
            clipboard_set,
            clipboard_get,
            window_closed,
            dev_log,
        ],
        hooks,
    );
}

// ---- commands -------------------------------------------------------------

#[tauri::command]
fn window_launch(
    window: tauri::Window,
    state: State<'_, FilesState>,
    process: State<'_, Launch>,
) -> Launch {
    if window.label() == "main" {
        return process.inner().clone();
    }
    state
        .launches
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
fn new_window(app: AppHandle, paths: Vec<String>, flags: Vec<String>) -> Result<String, String> {
    open_window(
        &app,
        Launch {
            paths,
            flags,
            cwd: "/".into(),
            urls: Vec::new(),
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn window_closed(window: tauri::Window, state: State<'_, FilesState>) {
    state.watches.drop_window(window.label());
    state.launches.lock().unwrap().remove(window.label());
}

#[tauri::command]
async fn list_dir(path: String, hidden: bool) -> Result<fs::Listing, String> {
    let p = expand(&path);
    tauri::async_runtime::spawn_blocking(move || fs::list(&p, hidden).map_err(io))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn places() -> Vec<places::Place> {
    tauri::async_runtime::spawn_blocking(|| places::compute(&places::system_env()))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn devices_list() -> Vec<devices::Device> {
    devices::list()
}

#[tauri::command]
fn device_action(state: State<'_, FilesState>, id: String, action: String) -> Result<(), String> {
    devices::act(&id, &action, state.emit.clone())
}

#[tauri::command]
fn connect_server(state: State<'_, FilesState>, uri: String) -> Result<(), String> {
    devices::connect(&uri, state.emit.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountReply {
    id: u64,
    #[serde(default)]
    cancel: bool,
    username: Option<String>,
    password: Option<String>,
    domain: Option<String>,
    #[serde(default)]
    anonymous: bool,
    #[serde(default)]
    remember: bool,
    choice: Option<i32>,
}

#[tauri::command]
fn mount_reply(reply: MountReply) -> bool {
    devices::mount_reply(
        reply.id,
        devices::Reply {
            cancel: reply.cancel,
            username: reply.username,
            password: reply.password,
            domain: reply.domain,
            anonymous: reply.anonymous,
            remember: reply.remember,
            choice: reply.choice,
        },
    )
}

#[tauri::command]
fn watch_dir(
    window: tauri::Window,
    state: State<'_, FilesState>,
    pane: String,
    path: Option<String>,
) {
    let key = format!("{}/{pane}", window.label());
    let p = path.map(|p| expand(&p));
    state.watches.set(&key, p.as_deref(), state.emit.clone());
}

#[tauri::command]
async fn make_folder(
    state: State<'_, FilesState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    let path = fs::mkdir(&expand(&dir), &name).map_err(io)?;
    state.ops.push_undo(ops::UndoRecord {
        label: format!("New folder “{name}”"),
        actions: vec![ops::UndoAction::RemoveEmpty { path: path.clone() }],
    });
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn make_file(
    state: State<'_, FilesState>,
    dir: String,
    name: String,
    template: Option<String>,
) -> Result<String, String> {
    let t = template.map(|t| expand(&t));
    let path = fs::create_file(&expand(&dir), &name, t.as_deref()).map_err(io)?;
    if t.is_none() {
        state.ops.push_undo(ops::UndoRecord {
            label: format!("New file “{name}”"),
            actions: vec![ops::UndoAction::RemoveEmpty { path: path.clone() }],
        });
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn rename_entry(
    state: State<'_, FilesState>,
    path: String,
    name: String,
) -> Result<String, String> {
    let from = expand(&path);
    let to = fs::rename(&from, &name).map_err(io)?;
    if to != from {
        state.ops.push_undo(ops::UndoRecord {
            label: format!("Rename to “{name}”"),
            actions: vec![ops::UndoAction::Rename {
                from: to.clone(),
                to: from,
            }],
        });
    }
    Ok(to.to_string_lossy().into_owned())
}

#[tauri::command]
async fn make_link(
    state: State<'_, FilesState>,
    target: String,
    dir: String,
) -> Result<String, String> {
    let link = fs::create_link(&expand(&target), &expand(&dir)).map_err(io)?;
    state.ops.push_undo(ops::UndoRecord {
        label: "Create link".into(),
        actions: vec![ops::UndoAction::RemoveTree { path: link.clone() }],
    });
    Ok(link.to_string_lossy().into_owned())
}

#[tauri::command]
fn templates() -> Vec<fs::Entry> {
    fs::templates(&home(), &ewe_app_core::xdg::config_home())
}

#[tauri::command]
fn op_start(
    window: tauri::Window,
    state: State<'_, FilesState>,
    kind: ops::OpKind,
    sources: Vec<String>,
    dest: Option<String>,
) -> u64 {
    state.ops.start(ops::OpRequest {
        kind,
        sources: sources.iter().map(|s| expand(s)).collect(),
        dest: dest.map(|d| expand(&d)),
        window: window.label().to_string(),
        trash_env: trash_env(),
    })
}

#[tauri::command]
fn op_pause(state: State<'_, FilesState>, id: u64) -> bool {
    state.ops.pause(id)
}

#[tauri::command]
fn op_resume(state: State<'_, FilesState>, id: u64) -> bool {
    state.ops.resume(id)
}

#[tauri::command]
fn op_cancel(state: State<'_, FilesState>, id: u64) -> bool {
    state.ops.cancel(id)
}

#[tauri::command]
fn op_resolve(state: State<'_, FilesState>, id: u64, choice: ops::Resolution, all: bool) -> bool {
    state.ops.resolve(id, choice, all)
}

#[tauri::command]
fn op_dismiss(state: State<'_, FilesState>, id: u64) {
    state.ops.dismiss(id)
}

#[tauri::command]
fn ops_list(state: State<'_, FilesState>) -> Vec<ops::Progress> {
    state.ops.list()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Undone {
    label: String,
    paths: Vec<String>,
}

#[tauri::command]
async fn undo(state: State<'_, FilesState>) -> Result<Option<Undone>, String> {
    let ops = state.ops.clone();
    tauri::async_runtime::spawn_blocking(move || ops.undo())
        .await
        .map_err(|e| e.to_string())?
        .map_err(io)
        .map(|r| {
            r.map(|(label, paths)| Undone {
                label,
                paths: paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            })
        })
}

#[tauri::command]
fn undo_label(state: State<'_, FilesState>) -> Option<String> {
    state.ops.undo_label()
}

#[tauri::command]
async fn trash_list() -> Vec<trash::TrashEntry> {
    tauri::async_runtime::spawn_blocking(|| trash::list(&trash_env()))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn archive_list(path: String) -> Result<archive::ArchiveListing, String> {
    let p = expand(&path);
    tauri::async_runtime::spawn_blocking(move || archive::list(&p).map_err(io))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_extract(path: String, dest: Option<String>) -> Result<String, String> {
    let p = expand(&path);
    let d = dest.map(|d| expand(&d));
    tauri::async_runtime::spawn_blocking(move || {
        match d {
            Some(d) => archive::extract_to(&p, &d),
            None => archive::extract_here(&p),
        }
        .map(|out| out.to_string_lossy().into_owned())
        .map_err(io)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_compress(
    paths: Vec<String>,
    format: String,
    name: Option<String>,
) -> Result<String, String> {
    let ps: Vec<PathBuf> = paths.iter().map(|p| expand(p)).collect();
    tauri::async_runtime::spawn_blocking(move || {
        archive::compress(&ps, &format, name.as_deref())
            .map(|out| out.to_string_lossy().into_owned())
            .map_err(io)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn search_start(
    window: tauri::Window,
    state: State<'_, FilesState>,
    root: String,
    filters: search::SearchFilters,
) -> u64 {
    state.search.start(
        expand(&root),
        filters,
        window.label().to_string(),
        state.emit.clone(),
    )
}

#[tauri::command]
fn search_stop(state: State<'_, FilesState>) {
    state.search.stop()
}

#[tauri::command]
async fn search_everywhere(query: String) -> Result<Vec<fs::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || search::everywhere(&query, 500))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stat_path(path: String) -> Result<props::Stat, String> {
    let p = expand(&path);
    tauri::async_runtime::spawn_blocking(move || props::stat(&p).map_err(io))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn chmod_path(path: String, mode: u32) -> Result<(), String> {
    props::chmod(&expand(&path), mode).map_err(io)
}

#[tauri::command]
fn folder_size_start(state: State<'_, FilesState>, paths: Vec<String>) -> u64 {
    let id = state.next_size.fetch_add(1, Ordering::SeqCst);
    let stop = Arc::new(AtomicBool::new(false));
    state.size_jobs.lock().unwrap().insert(id, stop.clone());
    let emit = state.emit.clone();
    let ps: Vec<PathBuf> = paths.iter().map(|p| expand(p)).collect();
    std::thread::spawn(move || props::folder_size(id, ps, emit, stop));
    id
}

#[tauri::command]
fn folder_size_stop(state: State<'_, FilesState>, id: u64) {
    if let Some(stop) = state.size_jobs.lock().unwrap().remove(&id) {
        stop.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn open_terminal(dir: String) -> Result<String, String> {
    misc::open_terminal(&expand(&dir))
}

#[tauri::command]
async fn set_wallpaper(path: String) -> Result<(), String> {
    let p = expand(&path);
    tauri::async_runtime::spawn_blocking(move || misc::set_wallpaper(&p))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn run_executable(path: String, terminal: bool) -> Result<(), String> {
    misc::run_executable(&expand(&path), terminal)
}

#[tauri::command]
fn komble_install(path: String) -> Result<(), String> {
    misc::komble_install(&expand(&path))
}

/// `{op: "available"}` | `{op: "pane", pane}` | `{op: "add-folder", path}`
#[tauri::command]
fn ewe_sync(op: String, pane: Option<String>, path: Option<String>) -> bool {
    match op.as_str() {
        "available" => misc::ewe_sync_available(),
        "pane" => misc::ewe_sync(&["--pane", pane.as_deref().unwrap_or("folders")]),
        "add-folder" => match path {
            Some(p) if p.starts_with('/') => misc::ewe_sync(&["--add-folder", &p]),
            _ => false,
        },
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tools {
    plocate: bool,
    bsdtar: bool,
    seven_zip: bool,
    unar: bool,
    komble: bool,
    ewe_sync: bool,
    ewe_conf: bool,
    terminal: bool,
    home: String,
    user: String,
}

#[tauri::command]
fn tools() -> Tools {
    Tools {
        plocate: misc::on_path("plocate").is_some(),
        bsdtar: misc::on_path("bsdtar").is_some(),
        seven_zip: misc::on_path("7z").is_some() || misc::on_path("7za").is_some(),
        unar: misc::on_path("unar").is_some(),
        komble: misc::on_path("komble").is_some(),
        ewe_sync: misc::ewe_sync_available(),
        ewe_conf: places::tool_path("ewe-conf").is_some(),
        terminal: misc::on_path("ewe-terminal-here").is_some()
            || std::env::var("TERMINAL")
                .ok()
                .map(|t| misc::on_path(&t).is_some())
                .unwrap_or(false)
            || misc::on_path("kitty").is_some()
            || misc::on_path("foot").is_some()
            || misc::on_path("alacritty").is_some(),
        home: home().to_string_lossy().into_owned(),
        user: std::env::var("USER").unwrap_or_default(),
    }
}

#[tauri::command]
fn clipboard_set(mode: String, paths: Vec<String>) -> bool {
    if mode != "copy" && mode != "cut" {
        return false;
    }
    clip::set(
        &mode,
        paths
            .iter()
            .map(|p| expand(p).to_string_lossy().into_owned())
            .collect(),
    )
}

#[tauri::command]
fn clipboard_get() -> Option<clip::Clip> {
    clip::get()
}

/// The webview's uncaught errors, on stderr (`scripts/shot.sh` keeps a log).
#[tauri::command]
fn dev_log(text: String) {
    eprintln!("ewe-files-app webview: {text}");
}

#[allow(dead_code)]
fn _assert_paths(_: &Path) {}
