//! The XDG base directories, honouring the environment (tests point them at temp dirs).

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn base(var: &str, fallback: &[&str]) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() && PathBuf::from(&v).is_absolute() => PathBuf::from(v),
        _ => {
            let mut p = home();
            for part in fallback {
                p.push(part);
            }
            p
        }
    }
}

pub fn config_home() -> PathBuf {
    base("XDG_CONFIG_HOME", &[".config"])
}

pub fn data_home() -> PathBuf {
    base("XDG_DATA_HOME", &[".local", "share"])
}

pub fn cache_home() -> PathBuf {
    base("XDG_CACHE_HOME", &[".cache"])
}

pub fn state_home() -> PathBuf {
    base("XDG_STATE_HOME", &[".local", "state"])
}

/// `$XDG_RUNTIME_DIR` (gone at sign-out), when the session has one.
pub fn runtime_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// `file://` URI for an absolute path, escaped the way GLib's `g_filename_to_uri`
/// does (what the thumbnail spec hashes and what GTK writes into recently-used.xbel).
pub fn file_uri(path: &std::path::Path) -> String {
    use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
    // g_escape_uri_string with UNSAFE_PATH: unreserved chars, `/` and `!$&'()*+,:;=@`
    // stay; everything else, space and `#?[]%"<>\^`{|}` included, is escaped.
    const UNSAFE: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');
    let text = path.to_string_lossy();
    format!("file://{}", utf8_percent_encode(&text, UNSAFE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn file_uri_escapes_like_glib() {
        assert_eq!(
            file_uri(Path::new("/home/me/My Files/a b#1.png")),
            "file:///home/me/My%20Files/a%20b%231.png"
        );
        assert_eq!(file_uri(Path::new("/x/ü.txt")), "file:///x/%C3%BC.txt");
        assert_eq!(file_uri(Path::new("/x/a+b,c.txt")), "file:///x/a+b,c.txt");
    }
}
