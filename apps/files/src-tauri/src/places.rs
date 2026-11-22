//! The places panel: Home, Applications (eep's `~/Applications`), the XDG folders,
//! Nextcloud / Google Drive through the
//! `ewe-files` / `ewe-drive` brokers, ewe-sync's synced folders
//! (`$XDG_STATE_HOME/ewe/sync-folders.json`), GTK bookmarks, `/run/media`, GVFS
//! mounts, rclone mounts, File system and Trash. Same shapes as ewe Browser's
//! `computePlaces` (`FsPlace` in `@ewe/shared`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaceSync {
    pub state: String,
    pub conflicts: u64,
    pub last_sync: Option<i64>,
    pub engine: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub label: String,
    pub path: String,
    pub group: &'static str,
    pub icon: &'static str,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync: Option<PlaceSync>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloudStatus {
    pub configured: bool,
    pub mounted: bool,
    pub path: Option<String>,
}

/// What places are built from; tests hand in a fake.
pub struct PlacesEnv {
    pub home: PathBuf,
    /// eep's apps folder ([`apps_dir`]); shown whether it exists yet or not
    pub apps: PathBuf,
    pub user: String,
    pub uid: u32,
    pub config_home: PathBuf,
    pub data_home: PathBuf,
    pub state_home: PathBuf,
    pub mounts: String,
    pub cloud: HashMap<&'static str, CloudStatus>,
}

/// eep's apps folder: `$EEP_APPS_DIR` (absolute) or `~/Applications` (eep/docs/CARD.md).
/// A card dropped in is installed, a card taken out uninstalled, by `eep watch`.
pub fn apps_dir(home: &Path, env_override: Option<&std::ffi::OsStr>) -> PathBuf {
    match env_override.map(Path::new) {
        Some(p) if p.is_absolute() => crate::fs::normalize(p),
        _ => home.join("Applications"),
    }
}

/// The apps folder of this session.
pub fn system_apps_dir(home: &Path) -> PathBuf {
    apps_dir(home, std::env::var_os("EEP_APPS_DIR").as_deref())
}

/// The Applications place is listed before its folder exists: opening it makes it.
/// Any other missing path stays missing (the pane says so).
pub fn ensure_apps_dir(path: &Path, apps: &Path) {
    if path == apps && !crate::fs::exists(path) {
        let _ = std::fs::create_dir_all(path);
    }
}

const XDG_DIRS: &[(&str, &str, &str)] = &[
    ("DESKTOP", "monitor", "Desktop"),
    ("DOCUMENTS", "file", "Documents"),
    ("DOWNLOAD", "download", "Downloads"),
    ("MUSIC", "music", "Music"),
    ("PICTURES", "image", "Pictures"),
    ("VIDEOS", "video", "Videos"),
    ("PROJECTS", "code", "Projects"),
];

pub fn parse_user_dirs(text: &str, home: &Path) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("XDG_") else {
            continue;
        };
        let Some((key, value)) = rest.split_once("_DIR=") else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        let path = match value.strip_prefix("$HOME") {
            Some(tail) => PathBuf::from(format!("{}{}", home.display(), tail)),
            None => PathBuf::from(value),
        };
        out.insert(key.to_string(), path);
    }
    out
}

pub fn parse_gtk_bookmarks(text: &str) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("file://") else {
            continue;
        };
        let (uri, label) = match rest.split_once(' ') {
            Some((u, l)) => (u, Some(l.to_string())),
            None => (rest, None),
        };
        let decoded = percent_encoding::percent_decode_str(uri)
            .decode_utf8_lossy()
            .into_owned();
        let trimmed = decoded.trim_end_matches('/');
        let path = PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed });
        let label = label.unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned())
        });
        out.push((path, label));
    }
    out
}

pub fn parse_mount_points(text: &str, fs_type: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split(' ').collect();
        if parts.len() > 2 && parts[2] == fs_type {
            out.push(PathBuf::from(
                parts[1].replace("\\040", " ").replace("\\011", "\t"),
            ));
        }
    }
    out
}

/// `type:key=value,key=value` → a label and an icon (the GVFS mount dir names).
pub fn gvfs_label(name: &str) -> (String, &'static str) {
    let Some((kind, spec)) = name.split_once(':') else {
        return (name.to_string(), "server");
    };
    let mut params: HashMap<&str, String> = HashMap::new();
    for part in spec.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            params.insert(
                k,
                percent_encoding::percent_decode_str(v)
                    .decode_utf8_lossy()
                    .into_owned(),
            );
        }
    }
    let host = params
        .get("host")
        .or_else(|| params.get("server"))
        .cloned()
        .unwrap_or_default();
    match kind {
        "google-drive" => (
            format!(
                "Google Drive ({})",
                params.get("user").cloned().unwrap_or(host)
            ),
            "cloud",
        ),
        "smb-share" => (
            format!(
                "{} on {host}",
                params
                    .get("share")
                    .cloned()
                    .unwrap_or_else(|| "share".into())
            ),
            "server",
        ),
        "sftp" | "ftp" => (
            match params.get("user") {
                Some(u) => format!("{u}@{host}"),
                None => host,
            },
            "server",
        ),
        "dav" | "davs" => (
            if host.is_empty() {
                "WebDAV".into()
            } else {
                host
            },
            "cloud",
        ),
        "mtp" | "gphoto2" => {
            let h = host.replace('_', " ");
            (if h.is_empty() { "Device".into() } else { h }, "drive")
        }
        _ => (
            if host.is_empty() {
                name.to_string()
            } else {
                format!("{host} ({kind})")
            },
            "server",
        ),
    }
}

#[derive(Debug, Clone)]
pub struct SyncFolder {
    pub name: String,
    pub local: PathBuf,
    pub sync: PlaceSync,
}

#[derive(Debug, Clone, Default)]
pub struct SyncSnapshot {
    pub folders: Vec<SyncFolder>,
    pub account_folder: Option<(PathBuf, String)>,
}

const SYNC_STATES: &[&str] = &[
    "synced", "syncing", "pending", "paused", "error", "conflict", "offline",
];

pub fn parse_sync_snapshot(text: &str) -> Option<SyncSnapshot> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("version")?.as_u64()? != 1 {
        return None;
    }
    let mut out = SyncSnapshot::default();
    for f in v.get("folders")?.as_array()?.iter().take(200) {
        let Some(local) = f.get("local").and_then(|l| l.as_str()) else {
            continue;
        };
        if !local.starts_with('/') || local == "/" {
            continue;
        }
        let local = PathBuf::from(local.trim_end_matches('/'));
        if out.folders.iter().any(|x| x.local == local) {
            continue;
        }
        let state = f
            .get("state")
            .and_then(|s| s.as_str())
            .filter(|s| SYNC_STATES.contains(s))
            .unwrap_or("pending")
            .to_string();
        let name = f
            .get("name")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| {
                local
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
        let last = f.get("last_sync").and_then(|s| s.as_f64()).unwrap_or(0.0);
        out.folders.push(SyncFolder {
            name,
            local,
            sync: PlaceSync {
                state,
                conflicts: f.get("conflicts").and_then(|c| c.as_u64()).unwrap_or(0),
                last_sync: if last > 0.0 {
                    Some((last * 1000.0).round() as i64)
                } else {
                    None
                },
                engine: if f.get("engine").and_then(|e| e.as_str()) == Some("nextcloud-app") {
                    "nextcloud-app".into()
                } else {
                    "ewe".into()
                },
                error: f
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
        });
    }
    if let Some(a) = v.get("account_folder")
        && let (Some(path), Some(state)) = (
            a.get("path").and_then(|p| p.as_str()),
            a.get("state").and_then(|s| s.as_str()),
        )
        && path.starts_with('/')
        && ["mounted", "synced", "off"].contains(&state)
    {
        out.account_folder = Some((PathBuf::from(path.trim_end_matches('/')), state.into()));
    }
    Some(out)
}

pub fn parse_cloud_status(text: &str) -> Option<CloudStatus> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    Some(CloudStatus {
        configured: o.get("configured").and_then(|b| b.as_bool()) == Some(true),
        mounted: o.get("mounted").and_then(|b| b.as_bool()) == Some(true),
        path: o
            .get("path")
            .and_then(|p| p.as_str())
            .filter(|p| p.starts_with('/'))
            .map(String::from),
    })
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

fn list_dirs(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn cloud_place(
    id: &'static str,
    label: &str,
    status: Option<&CloudStatus>,
    fallback: PathBuf,
) -> Option<Place> {
    let st = status?;
    Some(Place {
        id: id.into(),
        label: label.into(),
        path: st.path.clone().unwrap_or_else(|| s(&fallback)),
        group: "cloud",
        icon: "cloud",
        state: if st.mounted {
            "ready"
        } else if st.configured {
            "offline"
        } else {
            "setup"
        },
        mount: Some(id),
        sync: None,
    })
}

pub fn compute(env: &PlacesEnv) -> Vec<Place> {
    let mut places = vec![Place {
        id: "home".into(),
        label: "Home".into(),
        path: s(&env.home),
        group: "places",
        icon: "house",
        state: "ready",
        mount: None,
        sync: None,
    }];
    let dirs = parse_user_dirs(&read(&env.config_home.join("user-dirs.dirs")), &env.home);
    let mut seen = vec![env.home.clone()];
    // right under Home, like a Mac's Applications; listed before it exists (opening it
    // creates it, see `list_dir`)
    if env.apps != env.home {
        seen.push(env.apps.clone());
        places.push(Place {
            id: "applications".into(),
            label: "Applications".into(),
            path: s(&env.apps),
            group: "places",
            icon: "app-window",
            state: "ready",
            mount: None,
            sync: None,
        });
    }
    for (key, icon, fallback) in XDG_DIRS {
        let path = dirs
            .get(*key)
            .cloned()
            .unwrap_or_else(|| env.home.join(fallback));
        if seen.contains(&path) || !path.is_dir() {
            continue;
        }
        seen.push(path.clone());
        places.push(Place {
            id: format!("xdg-{}", key.to_lowercase()),
            label: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| fallback.to_string()),
            path: s(&path),
            group: "places",
            icon,
            state: "ready",
            mount: None,
            sync: None,
        });
    }

    let snapshot =
        parse_sync_snapshot(&read(&env.state_home.join("ewe").join("sync-folders.json")))
            .unwrap_or_default();
    let mut nextcloud = cloud_place(
        "nextcloud",
        "Nextcloud",
        env.cloud.get("ewe-files"),
        env.home.join("Nextcloud"),
    );
    if let Some((path, state)) = &snapshot.account_folder
        && state != "off"
    {
        match &mut nextcloud {
            None => {
                nextcloud = Some(Place {
                    id: "nextcloud".into(),
                    label: "Nextcloud".into(),
                    path: s(path),
                    group: "cloud",
                    icon: "cloud",
                    state: "ready",
                    mount: None,
                    sync: None,
                })
            }
            Some(nc) if nc.path == s(path) => nc.state = "ready",
            Some(_) => {}
        }
    }
    if let Some(nc) = &mut nextcloud
        && snapshot.folders.iter().any(|f| s(&f.local) == nc.path)
    {
        nc.state = "ready";
    }
    for place in [
        nextcloud,
        cloud_place(
            "drive",
            "Google Drive",
            env.cloud.get("ewe-drive"),
            env.home.join("Google Drive"),
        ),
    ]
    .into_iter()
    .flatten()
    {
        seen.push(PathBuf::from(&place.path));
        places.push(place);
    }

    for folder in &snapshot.folders {
        if let Some(existing) = places.iter_mut().find(|p| p.path == s(&folder.local)) {
            existing.sync = Some(folder.sync.clone());
            continue;
        }
        seen.push(folder.local.clone());
        places.push(Place {
            id: format!("synced-{}", folder.local.display()),
            label: folder.name.clone(),
            path: s(&folder.local),
            group: "synced",
            icon: "folder",
            state: if folder.local.is_dir() {
                "ready"
            } else {
                "offline"
            },
            mount: None,
            sync: Some(folder.sync.clone()),
        });
    }

    for (path, label) in parse_gtk_bookmarks(&read(&env.config_home.join("gtk-3.0/bookmarks"))) {
        if seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        places.push(Place {
            id: format!("bookmark-{}", path.display()),
            label,
            path: s(&path),
            group: "bookmarks",
            icon: "folder",
            state: if path.is_dir() { "ready" } else { "offline" },
            mount: None,
            sync: None,
        });
    }

    let media = Path::new("/run/media").join(&env.user);
    for name in list_dirs(&media) {
        let path = media.join(&name);
        seen.push(path.clone());
        places.push(Place {
            id: format!("media-{name}"),
            label: name,
            path: s(&path),
            group: "devices",
            icon: "drive",
            state: "ready",
            mount: None,
            sync: None,
        });
    }
    let gvfs = PathBuf::from(format!("/run/user/{}/gvfs", env.uid));
    for name in list_dirs(&gvfs) {
        let (label, icon) = gvfs_label(&name);
        let path = gvfs.join(&name);
        seen.push(path.clone());
        places.push(Place {
            id: format!("gvfs-{name}"),
            label,
            path: s(&path),
            group: "devices",
            icon,
            state: "ready",
            mount: None,
            sync: None,
        });
    }
    for path in parse_mount_points(&env.mounts, "fuse.rclone") {
        if seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        places.push(Place {
            id: format!("rclone-{}", path.display()),
            label: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| s(&path)),
            path: s(&path),
            group: "devices",
            icon: "cloud",
            state: "ready",
            mount: None,
            sync: None,
        });
    }

    places.push(Place {
        id: "root".into(),
        label: "File system".into(),
        path: "/".into(),
        group: "other",
        icon: "hard-drive",
        state: "ready",
        mount: None,
        sync: None,
    });
    places.push(Place {
        id: "trash".into(),
        label: "Trash".into(),
        path: "trash://".into(),
        group: "other",
        icon: "trash-2",
        state: "ready",
        mount: None,
        sync: None,
    });
    places
}

/// `$EWE_BIN` or `~/.local/share/ewe/bin`, then `PATH`.
pub fn tool_path(tool: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let bin = std::env::var_os("EWE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share/ewe/bin"));
    let local = bin.join(tool);
    if local.is_file() {
        return Some(local);
    }
    for dir in std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let p = dir.join(tool);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Run a tool with a timeout; its stdout, or None when missing or failed.
pub fn run_tool(tool: &str, args: &[&str], timeout: std::time::Duration) -> Option<String> {
    let path = tool_path(tool)?;
    let mut child = std::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut so) = child.stdout.take() {
                    let _ = std::io::Read::read_to_string(&mut so, &mut out);
                }
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

pub fn system_env() -> PlacesEnv {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let mut cloud = HashMap::new();
    for tool in ["ewe-files", "ewe-drive"] {
        if let Some(out) = run_tool(tool, &["status"], std::time::Duration::from_secs(4))
            && let Some(st) = parse_cloud_status(&out)
        {
            cloud.insert(tool, st);
        }
    }
    PlacesEnv {
        user: std::env::var("USER").unwrap_or_default(),
        // SAFETY: getuid has no preconditions
        uid: unsafe { libc::getuid() },
        config_home: ewe_app_core::xdg::config_home(),
        data_home: ewe_app_core::xdg::data_home(),
        state_home: match std::env::var_os("XDG_STATE_HOME") {
            Some(v) if !v.is_empty() => PathBuf::from(v),
            _ => home.join(".local/state"),
        },
        mounts: read(Path::new("/proc/mounts")),
        cloud,
        apps: system_apps_dir(&home),
        home,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_dirs_bookmarks_mounts_and_gvfs() {
        let d = parse_user_dirs(
            "XDG_DOWNLOAD_DIR=\"$HOME/Downloads\"\nXDG_MUSIC_DIR=\"/data/Music\"\n# x\n",
            Path::new("/home/me"),
        );
        assert_eq!(d["DOWNLOAD"], PathBuf::from("/home/me/Downloads"));
        assert_eq!(d["MUSIC"], PathBuf::from("/data/Music"));
        let b = parse_gtk_bookmarks(
            "file:///home/me/Nextcloud/\nfile:///srv/My%20Share Work share\nhttp://x\n",
        );
        assert_eq!(
            b[0],
            (PathBuf::from("/home/me/Nextcloud"), "Nextcloud".into())
        );
        assert_eq!(b[1], (PathBuf::from("/srv/My Share"), "Work share".into()));
        let m = parse_mount_points(
            "x /mnt/a fuse.rclone rw 0 0\ny /mnt/b ext4 rw 0 0\nz /mnt/c\\040d fuse.rclone rw 0 0\n",
            "fuse.rclone",
        );
        assert_eq!(m, vec![PathBuf::from("/mnt/a"), PathBuf::from("/mnt/c d")]);
        assert_eq!(
            gvfs_label("smb-share:server=nas,share=photos"),
            ("photos on nas".into(), "server")
        );
        assert_eq!(
            gvfs_label("sftp:host=box,user=me"),
            ("me@box".into(), "server")
        );
        assert_eq!(gvfs_label("mtp:host=Pixel_8"), ("Pixel 8".into(), "drive"));
        assert_eq!(
            gvfs_label("google-drive:host=gmail.com,user=a%40b"),
            ("Google Drive (a@b)".into(), "cloud")
        );
    }

    #[test]
    fn parses_sync_snapshot_and_cloud_status() {
        let snap = parse_sync_snapshot(
            r#"{"version":1,"signed_in":true,"folders":[{"name":"Docs","local":"/home/me/Documents/","state":"syncing","conflicts":2,"last_sync":1700000000.5,"engine":"ewe"},{"local":"/","state":"synced"},{"local":"/home/me/Documents","state":"synced"}],"account_folder":{"path":"/home/me/Nextcloud","state":"synced"}}"#,
        )
        .unwrap();
        assert_eq!(snap.folders.len(), 1);
        assert_eq!(snap.folders[0].local, PathBuf::from("/home/me/Documents"));
        assert_eq!(snap.folders[0].sync.state, "syncing");
        assert_eq!(snap.folders[0].sync.conflicts, 2);
        assert_eq!(snap.folders[0].sync.last_sync, Some(1_700_000_000_500));
        assert_eq!(
            snap.account_folder,
            Some((PathBuf::from("/home/me/Nextcloud"), "synced".into()))
        );
        assert!(parse_sync_snapshot(r#"{"version":2,"folders":[]}"#).is_none());
        let st = parse_cloud_status(r#"{"configured":true,"mounted":false,"path":"/x"}"#).unwrap();
        assert!(st.configured && !st.mounted);
        assert_eq!(st.path.as_deref(), Some("/x"));
    }

    #[test]
    fn opening_applications_makes_it() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        ensure_apps_dir(&dir.path().join("Elsewhere"), &apps);
        assert!(!dir.path().join("Elsewhere").exists());
        ensure_apps_dir(&apps, &apps);
        assert!(apps.is_dir());
        ensure_apps_dir(&apps, &apps);
        assert!(apps.is_dir());
    }

    #[test]
    fn apps_dir_follows_eep() {
        let home = Path::new("/home/me");
        assert_eq!(apps_dir(home, None), PathBuf::from("/home/me/Applications"));
        assert_eq!(
            apps_dir(home, Some(std::ffi::OsStr::new("/data/apps/"))),
            PathBuf::from("/data/apps")
        );
        assert_eq!(
            apps_dir(home, Some(std::ffi::OsStr::new("relative"))),
            PathBuf::from("/home/me/Applications")
        );
    }

    #[test]
    fn computes_places_from_a_fake_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        for d in [
            "Downloads",
            "Pictures",
            "Work",
            "Nextcloud",
            ".config/gtk-3.0",
            ".local/state/ewe",
        ] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(
            home.join(".config/gtk-3.0/bookmarks"),
            format!(
                "file://{0}/Work\nfile://{0}/Nextcloud/\nfile://{0}/Gone\n",
                home.display()
            ),
        )
        .unwrap();
        std::fs::write(
            home.join(".local/state/ewe/sync-folders.json"),
            format!(
                r#"{{"version":1,"folders":[{{"name":"Pictures","local":"{0}/Pictures","state":"synced"}},{{"name":"Notes","local":"{0}/Notes","state":"pending"}}],"account_folder":{{"path":"{0}/Nextcloud","state":"synced"}}}}"#,
                home.display()
            ),
        )
        .unwrap();
        let env = PlacesEnv {
            apps: apps_dir(&home, None),
            home: home.clone(),
            user: "me".into(),
            uid: 424242,
            config_home: home.join(".config"),
            data_home: home.join(".local/share"),
            state_home: home.join(".local/state"),
            mounts: String::new(),
            cloud: HashMap::new(),
        };
        let places = compute(&env);
        let ids: Vec<&str> = places.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids[0], "home");
        // Applications comes right after Home even before the folder exists
        assert_eq!(ids[1], "applications");
        assert!(!home.join("Applications").exists());
        assert_eq!(places[1].path, s(&home.join("Applications")));
        assert_eq!((places[1].icon, places[1].group), ("app-window", "places"));
        assert!(ids.contains(&"xdg-download") && ids.contains(&"xdg-pictures"));
        assert!(!ids.contains(&"xdg-documents"));
        let nc = places.iter().find(|p| p.id == "nextcloud").unwrap();
        assert_eq!((nc.group, nc.state), ("cloud", "ready"));
        let pics = places.iter().find(|p| p.id == "xdg-pictures").unwrap();
        assert_eq!(pics.sync.as_ref().unwrap().state, "synced");
        let notes = places.iter().find(|p| p.group == "synced").unwrap();
        assert_eq!((notes.label.as_str(), notes.state), ("Notes", "offline"));
        let books: Vec<&Place> = places.iter().filter(|p| p.group == "bookmarks").collect();
        assert_eq!(books.len(), 2, "Nextcloud bookmark dedupes: {books:?}");
        assert_eq!(books[0].label, "Work");
        assert_eq!(books[1].state, "offline");
        assert_eq!(places[places.len() - 2].id, "root");
        assert_eq!(places[places.len() - 1].path, "trash://");
    }
}
