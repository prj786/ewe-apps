//! Content types and applications through GIO (the same answers Nemo and `gio open` give).
//! GIO objects are not `Send`, so these run synchronously on the caller's thread; the
//! Tauri commands that wrap them are plain (main-thread) commands.

use std::path::Path;

use gio::prelude::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MimeInfo {
    pub path: String,
    #[serde(rename = "type")]
    pub content_type: String,
    pub description: String,
    pub uncertain: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    /// the icon's file in the icon theme (an SVG or a PNG), for the page to show
    pub icon_path: Option<String>,
    pub exec: String,
    pub default: bool,
}

/// The size app icons are looked up at: twice the 24px a row shows, for a 2× screen.
const ICON_SIZE: i32 = 48;

/// The file of an app's icon in the current icon theme. Main thread only (GTK); `None`
/// without a display, or when the theme has no such icon.
fn icon_file(icon: &gio::Icon) -> Option<String> {
    use gtk::prelude::IconThemeExt;
    let theme = gtk::IconTheme::default()?;
    let info = theme.lookup_by_gicon(icon, ICON_SIZE, gtk::IconLookupFlags::FORCE_SIZE)?;
    let path = info.filename()?;
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// The content type of a path: directory, or sniffed from the name and the first 4 KiB.
pub fn content_type(path: &Path) -> MimeInfo {
    let text = path.to_string_lossy().into_owned();
    if path.is_dir() {
        return MimeInfo {
            path: text,
            content_type: "inode/directory".into(),
            description: gio::functions::content_type_get_description("inode/directory").into(),
            uncertain: false,
        };
    }
    // Only a regular file is opened for a look at its first bytes. Opening a FIFO with
    // no writer never returns (`~/.steam/steam.pipe` froze the app when it was merely
    // selected with the preview open), and a device is not ours to read: the name
    // has to do for those.
    let mut head = Vec::new();
    if std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && let Ok(f) = std::fs::File::open(path)
    {
        use std::io::Read;
        let _ = f.take(4096).read_to_end(&mut head);
    }
    let (ct, uncertain) = gio::functions::content_type_guess(Some(path), &head);
    MimeInfo {
        path: text,
        description: gio::functions::content_type_get_description(&ct).into(),
        content_type: ct.into(),
        uncertain,
    }
}

fn describe(app: &gio::AppInfo, default_id: Option<&str>) -> Option<AppInfo> {
    let id = app.id()?.to_string();
    Some(AppInfo {
        default: default_id == Some(id.as_str()),
        name: app.name().to_string(),
        icon: app
            .icon()
            .and_then(|i| IconExt::to_string(&i))
            .map(|s| s.to_string()),
        icon_path: app.icon().as_ref().and_then(icon_file),
        exec: app
            .commandline()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        id,
    })
}

/// Every app that says it opens `content_type`, the default first.
pub fn apps_for(content_type: &str) -> Vec<AppInfo> {
    let default = gio::AppInfo::default_for_type(content_type, false).and_then(|a| a.id());
    let default_id = default.as_deref();
    let mut out: Vec<AppInfo> = gio::AppInfo::all_for_type(content_type)
        .iter()
        .filter_map(|a| describe(a, default_id))
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.default));
    out
}

/// Every installed app that shows in a menu (for "Other app…").
pub fn all_apps() -> Vec<AppInfo> {
    gio::AppInfo::all()
        .iter()
        .filter(|a| a.should_show())
        .filter_map(|a| describe(a, None))
        .collect()
}

pub fn default_app(content_type: &str) -> Option<AppInfo> {
    let app = gio::AppInfo::default_for_type(content_type, false)?;
    let id = app.id().map(|s| s.to_string());
    describe(&app, id.as_deref())
}

/// Make `desktop_id` the default for `content_type` (writes mimeapps.list for this user).
pub fn set_default(desktop_id: &str, content_type: &str) -> Result<(), String> {
    let app = gio::DesktopAppInfo::new(desktop_id).ok_or_else(|| format!("no app {desktop_id}"))?;
    app.set_as_default_for_type(content_type)
        .map_err(|e| e.to_string())
}

/// Open `paths` with `desktop_id` (or the default app for the first path's type).
pub fn launch(desktop_id: Option<&str>, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to open".into());
    }
    let files: Vec<gio::File> = paths.iter().map(gio::File::for_path).collect();
    let app: gio::AppInfo = match desktop_id {
        Some(id) => gio::DesktopAppInfo::new(id)
            .ok_or_else(|| format!("no app {id}"))?
            .upcast(),
        None => {
            let ct = content_type(Path::new(&paths[0])).content_type;
            gio::AppInfo::default_for_type(&ct, false).ok_or_else(|| format!("no app for {ct}"))?
        }
    };
    app.launch(&files, None::<&gio::AppLaunchContext>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_types() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let info = content_type(&png);
        assert_eq!(info.content_type, "image/png");
        assert!(!info.description.is_empty());
        assert_eq!(content_type(dir.path()).content_type, "inode/directory");
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, "hello\n").unwrap();
        assert_eq!(content_type(&txt).content_type, "text/plain");
    }

    #[test]
    fn a_pipe_is_named_without_being_opened() {
        let dir = tempfile::tempdir().unwrap();
        let pipe = dir.path().join("steam.pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .unwrap();
        assert!(status.success());
        // opening it would wait for a writer for ever; this returns
        let info = content_type(&pipe);
        assert!(!info.content_type.is_empty());
    }
}
