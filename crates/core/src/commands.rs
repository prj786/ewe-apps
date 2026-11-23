//! The Tauri commands every app exposes (see [`crate::handler!`]).

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::launch::Launch;
use crate::mime::{AppInfo, MimeInfo};
use crate::server::MediaServerInfo;

/// What the app is called: filled from [`crate::AppSpec`] by [`crate::run`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    /// the binary / app_id / desktop id stem, e.g. `ewe-viewer`
    pub id: &'static str,
    /// the product name, e.g. `ewe Viewer`
    pub name: &'static str,
    pub version: &'static str,
}

/// The parsed token file (null when none): the webview maps it to CSS.
#[tauri::command]
pub fn theme_tokens() -> Option<Value> {
    crate::theme::read(&crate::theme::tokens_path())
}

#[tauri::command]
pub fn media_server(info: State<'_, MediaServerInfo>) -> MediaServerInfo {
    info.inner().clone()
}

#[tauri::command]
pub fn launch_args(launch: State<'_, Launch>) -> Launch {
    launch.inner().clone()
}

#[tauri::command]
pub fn app_version(identity: State<'_, AppIdentity>) -> AppIdentity {
    identity.inner().clone()
}

/// Record `path` in recently-used.xbel for this app.
#[tauri::command]
pub async fn add_recent(
    identity: State<'_, AppIdentity>,
    path: String,
    mime_type: Option<String>,
) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("not an absolute path".into());
    }
    let (name, id) = (identity.name, identity.id);
    tauri::async_runtime::spawn_blocking(move || {
        crate::recent::add(
            &crate::recent::xbel_path(),
            std::path::Path::new(&path),
            mime_type.as_deref(),
            name,
            id,
            chrono::Utc::now(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Off the main thread: it reads the file's first bytes, and on a network folder that
/// is a round trip per selected file (the preview pane asks for each).
#[tauri::command]
pub async fn mime_of(path: String) -> Result<MimeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::mime::content_type(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Apps for a content type (default first); `all` lists every installed app instead.
#[tauri::command]
pub fn apps_for(content_type: String, all: Option<bool>) -> Vec<AppInfo> {
    if all == Some(true) {
        crate::mime::all_apps()
    } else {
        crate::mime::apps_for(&content_type)
    }
}

#[tauri::command]
pub fn default_app(content_type: String) -> Option<AppInfo> {
    crate::mime::default_app(&content_type)
}

#[tauri::command]
pub fn set_default_app(desktop_id: String, content_type: String) -> Result<(), String> {
    crate::mime::set_default(&desktop_id, &content_type)
}

/// Open `paths` with `desktopId` (null: the default app for the first one).
#[tauri::command]
pub fn launch_with(desktop_id: Option<String>, paths: Vec<String>) -> Result<(), String> {
    crate::mime::launch(desktop_id.as_deref(), &paths)
}

/// A start-up mark from the page (see [`crate::trace`]): `at` is ms since the epoch.
#[tauri::command]
pub fn trace_mark(label: String, at: f64) {
    crate::trace::mark_at(&label, at);
}
