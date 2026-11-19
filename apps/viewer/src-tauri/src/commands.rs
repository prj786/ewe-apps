//! ewe Viewer's own Tauri commands (the shared ones are in ewe-app-core's `handler!`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use gio::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::comics;

const VIEWABLE: &[&str] = &[
    "pdf", "epub", "cbz", "cbr", "cb7", "cbt", "md", "markdown", "txt", "rst", "log", "csv", "tsv",
    "json", "xml", "yaml", "yml", "toml", "ini", "conf", "cfg", "sh", "py", "js", "ts", "tsx",
    "jsx", "rs", "go", "c", "h", "cpp", "hpp", "java", "kt", "swift", "lua", "qml", "php", "rb",
    "sql", "css", "scss", "html", "htm", "svg", "docx", "xlsx", "xlsm", "ods", "odt", "pptx",
    "doc", "rtf", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico", "heic",
    "heif", "jxl",
];

const IMAGES: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico", "heic", "heif",
    "jxl", "svg",
];

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("not an absolute path".into());
    }
    Ok(PathBuf::from(path))
}

/// Webview errors and warnings → stderr (`index.tsx` forwards them), so a headless run's
/// log says why a document did not open.
#[tauri::command]
pub fn debug_log(level: String, message: String) {
    eprintln!("ewe-viewer webview {level}: {message}");
}

// ── per-app data files ($XDG_DATA_HOME/ewe-viewer/<name>.json) ─────────────────

fn data_dir() -> PathBuf {
    ewe_app_core::xdg::data_home().join("ewe-viewer")
}

fn data_file(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        return Err("bad store name".into());
    }
    Ok(data_dir().join(format!("{name}.json")))
}

/// A JSON document kept under `$XDG_DATA_HOME/ewe-viewer/` (null when there is none).
#[tauri::command]
pub async fn store_read(name: String) -> Result<Option<Value>, String> {
    let file = data_file(&name)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).or(Ok(None)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the whole document atomically (temp file + rename, 0600).
#[tauri::command]
pub async fn store_write(name: String, value: Value) -> Result<(), String> {
    let file = data_file(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = file.parent().ok_or("no parent")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(
            ".{}.{}.tmp",
            file.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id()
        ));
        write_private(
            &tmp,
            &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    std::io::Write::write_all(&mut f, bytes)
}

// ── files ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// ms since the epoch
    pub modified: i64,
    pub exists: bool,
}

fn stat(path: &Path) -> FileStat {
    let meta = std::fs::metadata(path).ok();
    FileStat {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        exists: meta.is_some_and(|m| m.is_file()),
    }
}

#[tauri::command]
pub fn file_stat(path: String) -> Result<FileStat, String> {
    Ok(stat(&absolute(&path)?))
}

/// The pictures in the file's folder, in natural order (for ←/→ stepping).
#[tauri::command]
pub async fn folder_images(path: String) -> Result<Vec<String>, String> {
    let file = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = file.parent().ok_or("no folder")?;
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| !t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.') && IMAGES.contains(&extension(Path::new(n)).as_str()))
            .collect();
        names.sort_by(|a, b| comics::natural_cmp(a, b));
        Ok(names
            .into_iter()
            .map(|n| dir.join(n).to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub stat: FileStat,
    pub exif: Option<ewe_app_core::exif::ExifInfo>,
}

#[tauri::command]
pub async fn image_info(path: String) -> Result<ImageInfo, String> {
    let file = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || ImageInfo {
        stat: stat(&file),
        exif: ewe_app_core::exif::read(&file),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Move a file to the Trash through GIO (so Files' Trash place and Undo see it).
#[tauri::command]
pub fn trash_file(path: String) -> Result<(), String> {
    let file = absolute(&path)?;
    gio::File::for_path(&file)
        .trash(None::<&gio::Cancellable>)
        .map_err(|e| e.to_string())
}

/// Open an http(s)/mailto URL with the default app (links in PDFs, Markdown, books).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("only web and mail links open outside".into());
    }
    gio::AppInfo::launch_default_for_uri(&url, None::<&gio::AppLaunchContext>)
        .map_err(|e| e.to_string())
}

/// Exactly what Nemo's "Set as Wallpaper" action runs: `ewe-conf` writes
/// `desktop.wallpapers.default` (the only writer of ewe.conf), then the Hyprland
/// wallpaper script redraws.
#[tauri::command]
pub async fn set_wallpaper(path: String) -> Result<(), String> {
    let file = absolute(&path)?;
    if !file.is_file() {
        return Err("That picture is not there any more.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let value = serde_json::to_string(&file.to_string_lossy()).map_err(|e| e.to_string())?;
        let status = Command::new("ewe-conf")
            .args(["set", "desktop.wallpapers.default", &value])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("ewe-conf: {e}"))?;
        if !status.success() {
            return Err("ewe-conf could not save the wallpaper.".into());
        }
        let script = ewe_app_core::xdg::config_home().join("hypr/scripts/wallpaper.sh");
        let _ = Command::new(script)
            .arg("--reapply")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put a picture on the Wayland clipboard (`wl-copy` keeps serving it after we quit).
#[tauri::command]
pub async fn copy_image(path: String, mime: String) -> Result<(), String> {
    let file = absolute(&path)?;
    if !mime.starts_with("image/") || mime.contains(|c: char| c.is_whitespace()) {
        return Err("not a picture type".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let input = std::fs::File::open(&file).map_err(|e| e.to_string())?;
        let status = Command::new("wl-copy")
            .args(["--type", &mime])
            .stdin(Stdio::from(input))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("wl-copy: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("wl-copy could not take the picture.".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write raw bytes (the body) to the path in the `path` header — "Save a copy" of a
/// filled form. Refuses relative paths.
#[tauri::command]
pub async fn save_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("no path header")?;
    let path = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned();
    let file = absolute(&path)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected bytes".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&file, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── comics ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn comic_list(path: String) -> Result<comics::ComicListing, String> {
    let file = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || comics::list(&file))
        .await
        .map_err(|e| e.to_string())?
}

/// One page's bytes (a raw IPC response, no base64).
#[tauri::command]
pub async fn comic_page(
    path: String,
    name: String,
    source: String,
) -> Result<tauri::ipc::Response, String> {
    let file = absolute(&path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || comics::page(&file, &name, &source))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

// ── recent documents ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDoc {
    pub path: String,
    pub name: String,
    pub mime: Option<String>,
    /// ms since the epoch (when it was last opened)
    pub opened: i64,
    pub size: u64,
}

/// Documents from `recently-used.xbel` that still exist and this app can show,
/// newest first, at most `limit`.
#[tauri::command]
pub async fn recent_documents(limit: Option<usize>) -> Result<Vec<RecentDoc>, String> {
    let limit = limit.unwrap_or(24).min(200);
    tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(ewe_app_core::recent::xbel_path()).unwrap_or_default();
        let mut docs: Vec<RecentDoc> = ewe_app_core::recent::parse(&text)
            .into_iter()
            .filter_map(|b| {
                let rest = b.href.strip_prefix("file://")?;
                let path = percent_encoding::percent_decode_str(rest)
                    .decode_utf8()
                    .ok()?
                    .into_owned();
                let p = Path::new(&path);
                if !VIEWABLE.contains(&extension(p).as_str()) {
                    return None;
                }
                let st = stat(p);
                if !st.exists {
                    return None;
                }
                let opened = chrono::DateTime::parse_from_rfc3339(&b.modified)
                    .or_else(|_| chrono::DateTime::parse_from_rfc3339(&b.visited))
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(0);
                Some(RecentDoc {
                    path,
                    name: st.name,
                    mime: b.mime,
                    opened,
                    size: st.size,
                })
            })
            .collect();
        docs.sort_by_key(|d| std::cmp::Reverse(d.opened));
        docs.truncate(limit);
        Ok(docs)
    })
    .await
    .map_err(|e| e.to_string())?
}
