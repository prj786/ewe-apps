//! What this machine can do for the player, asked once: is gst-libav there (so the error
//! page blames it only when it really is missing), is yt-dlp there (videos from web pages),
//! is mpv there (the fallback for what WebKit cannot stream).
//!
//! Overrides for tests and screenshots: `EWE_PLAYER_YTDLP=<path>` (the yt-dlp to run, e.g.
//! one unpacked into a scratch folder; a missing path means "not installed"),
//! `EWE_PLAYER_LIBAV=0|1` (answer as if gst-libav were missing / present). The GStreamer
//! plugin path variables are honoured, so hiding the plugin from GStreamer
//! (`GST_PLUGIN_SYSTEM_PATH`) hides it from this check too.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSupport {
    /// gst-libav (FFmpeg decoders for GStreamer) is installed
    pub libav: bool,
    /// yt-dlp can be run
    pub ytdlp: bool,
    /// mpv is on PATH
    pub mpv: bool,
}

/// The GStreamer plugin of gst-libav.
const LIBAV_PLUGIN: &str = "libgstlibav.so";

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `name` in `$PATH`, like `which`.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
}

/// The yt-dlp to run: `$EWE_PLAYER_YTDLP` when set, else `yt-dlp` on PATH.
pub fn ytdlp_path() -> Option<PathBuf> {
    match std::env::var_os("EWE_PLAYER_YTDLP") {
        Some(p) if !p.is_empty() => {
            let p = PathBuf::from(p);
            is_executable(&p).then_some(p)
        }
        _ => find_on_path("yt-dlp"),
    }
}

/// Where GStreamer looks for plugins, from the same variables it reads.
pub fn gst_plugin_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let split = |v: String| -> Vec<PathBuf> {
        v.split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect()
    };
    let mut dirs = Vec::new();
    for var in ["GST_PLUGIN_PATH_1_0", "GST_PLUGIN_PATH"] {
        if let Some(v) = env(var) {
            dirs.extend(split(v));
        }
    }
    let system = env("GST_PLUGIN_SYSTEM_PATH_1_0").or_else(|| env("GST_PLUGIN_SYSTEM_PATH"));
    match system {
        // set (even empty): it replaces the built-in system directories
        Some(v) => dirs.extend(split(v)),
        None => {
            dirs.push(PathBuf::from("/usr/lib/gstreamer-1.0"));
            let data = env("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| env("HOME").map(|h| PathBuf::from(h).join(".local/share")));
            if let Some(d) = data {
                dirs.push(d.join("gstreamer-1.0/plugins"));
            }
        }
    }
    dirs
}

pub fn libav_in(dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|d| d.join(LIBAV_PLUGIN).is_file())
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub fn libav_present() -> bool {
    match env_var("EWE_PLAYER_LIBAV").as_deref() {
        Some("0") => return false,
        Some("1") => return true,
        _ => {}
    }
    if libav_in(&gst_plugin_dirs(&env_var)) {
        return true;
    }
    // not where Arch puts it: ask GStreamer itself (rebuilds its registry if it must)
    Command::new("gst-inspect-1.0")
        .args(["--exists", "avdec_h264"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn detect() -> MediaSupport {
    MediaSupport {
        libav: libav_present(),
        ytdlp: ytdlp_path().is_some(),
        mpv: find_on_path("mpv").is_some(),
    }
}

static CACHE: OnceLock<MediaSupport> = OnceLock::new();

/// Detected once per run (a package installed meanwhile shows after a restart).
pub fn cached() -> MediaSupport {
    *CACHE.get_or_init(detect)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn plugin_dirs_follow_gstreamer_variables() {
        let dirs = gst_plugin_dirs(&env_of(&[("HOME", "/home/me")]));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/usr/lib/gstreamer-1.0"),
                PathBuf::from("/home/me/.local/share/gstreamer-1.0/plugins")
            ]
        );
        let dirs = gst_plugin_dirs(&env_of(&[
            ("GST_PLUGIN_PATH", "/opt/a:/opt/b"),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/no-libav"),
        ]));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/opt/a"),
                PathBuf::from("/opt/b"),
                PathBuf::from("/tmp/no-libav")
            ]
        );
    }

    #[test]
    fn finds_the_libav_plugin_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!libav_in(&[dir.path().to_path_buf()]));
        std::fs::write(dir.path().join(LIBAV_PLUGIN), b"").unwrap();
        assert!(libav_in(&[
            PathBuf::from("/nonexistent"),
            dir.path().to_path_buf()
        ]));
    }

    #[test]
    fn executables_only() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("tool");
        std::fs::write(&f, b"#!/bin/sh\n").unwrap();
        assert!(!is_executable(&f));
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(&f));
        assert!(!is_executable(dir.path()));
    }
}
