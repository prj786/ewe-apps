//! argv → what the app was asked to open.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    /// absolute paths; `file://` URLs are turned into paths, relative ones joined to `cwd`
    pub paths: Vec<String>,
    /// `--flag` and `--key=value` tokens, in order, for the app to interpret
    pub flags: Vec<String>,
    pub cwd: String,
    /// `http(s)://` (and other non-file) URLs, in order, for the apps that stream
    #[serde(default)]
    pub urls: Vec<String>,
}

impl Launch {
    /// `args` without the program name.
    pub fn parse<I, S>(args: I, cwd: &Path) -> Launch
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut out = Launch {
            cwd: cwd.to_string_lossy().into_owned(),
            ..Launch::default()
        };
        let mut only_paths = false;
        for arg in args {
            let a = arg.as_ref();
            if !only_paths && a == "--" {
                only_paths = true;
                continue;
            }
            if !only_paths && a.starts_with("--") && a.len() > 2 {
                out.flags.push(a.to_string());
                continue;
            }
            if let Some(p) = to_path(a, cwd) {
                out.paths.push(p.to_string_lossy().into_owned());
            } else if is_remote_url(a) {
                out.urls.push(a.to_string());
            }
        }
        out
    }

    /// `--version` is the one flag the core answers itself.
    pub fn wants_version(&self) -> bool {
        self.flags.iter().any(|f| f == "--version")
    }
}

/// `scheme://…` with a scheme of letters, digits, `+`, `-`, `.` (RFC 3986) that is not `file`.
fn is_remote_url(arg: &str) -> bool {
    let Some((scheme, rest)) = arg.split_once("://") else {
        return false;
    };
    !rest.is_empty()
        && scheme != "file"
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
}

fn to_path(arg: &str, cwd: &Path) -> Option<PathBuf> {
    if arg.is_empty() || arg.contains('\0') {
        return None;
    }
    if let Some(rest) = arg.strip_prefix("file://") {
        // file:///home/me/a%20b.png — the host part, when present, must be local
        let path = rest.strip_prefix("localhost").unwrap_or(rest);
        if !path.starts_with('/') {
            return None;
        }
        let decoded = percent_encoding::percent_decode_str(path)
            .decode_utf8()
            .ok()?;
        return Some(PathBuf::from(decoded.into_owned()));
    }
    if arg.contains("://") {
        // http(s) and friends are not files; the apps that take URLs read `flags`
        return None;
    }
    let p = Path::new(arg);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        normalize(&cwd.join(p))
    })
}

/// Lexical `.` / `..` removal (no symlink resolution: the file may not exist yet).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Launch {
        Launch::parse(args.iter().copied(), Path::new("/home/me/work"))
    }

    #[test]
    fn splits_flags_from_paths() {
        let l = parse(&["--select", "--tab=2", "/a/b.png", "sub/c.txt", "../d"]);
        assert_eq!(l.flags, vec!["--select", "--tab=2"]);
        assert_eq!(
            l.paths,
            vec!["/a/b.png", "/home/me/work/sub/c.txt", "/home/me/d"]
        );
        assert_eq!(l.cwd, "/home/me/work");
        assert!(!l.wants_version());
        assert!(parse(&["--version"]).wants_version());
    }

    #[test]
    fn turns_file_urls_into_paths_and_drops_other_urls() {
        let l = parse(&[
            "file:///home/me/My%20Files/a%23.png",
            "file://localhost/x/y",
            "https://example.com/v.mp4",
            "-",
        ]);
        assert_eq!(
            l.paths,
            vec!["/home/me/My Files/a#.png", "/x/y", "/home/me/work/-"]
        );
        assert!(l.flags.is_empty());
        assert_eq!(l.urls, vec!["https://example.com/v.mp4"]);
    }

    #[test]
    fn keeps_remote_urls_for_the_apps_that_stream() {
        let l = parse(&[
            "https://example.com/live/index.m3u8",
            "http://10.0.0.5:8080/cam",
            "rtsp://cam.local/stream",
            "nope://",
            "1://x",
            "file:///a.mp4",
        ]);
        assert_eq!(
            l.urls,
            vec![
                "https://example.com/live/index.m3u8",
                "http://10.0.0.5:8080/cam",
                "rtsp://cam.local/stream",
            ]
        );
        assert_eq!(l.paths, vec!["/a.mp4"]);
    }

    #[test]
    fn double_dash_ends_flags() {
        let l = parse(&["--", "--weird-name"]);
        assert!(l.flags.is_empty());
        assert_eq!(l.paths, vec!["/home/me/work/--weird-name"]);
    }
}
