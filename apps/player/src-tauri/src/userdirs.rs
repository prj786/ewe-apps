//! `XDG_<NAME>_DIR` from `user-dirs.dirs` (Music, Pictures), with the usual fallback.

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn parse_user_dirs(text: &str, name: &str, home: &std::path::Path) -> Option<PathBuf> {
    let key = format!("XDG_{name}_DIR=");
    for line in text.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix(&key) else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        let value = value.replace("$HOME", &home.to_string_lossy());
        if value.is_empty() {
            continue;
        }
        let p = PathBuf::from(value);
        return Some(if p.is_absolute() { p } else { home.join(p) });
    }
    None
}

/// `user_dir("MUSIC", "Music")` → `XDG_MUSIC_DIR` or `~/Music`.
pub fn user_dir(name: &str, fallback: &str) -> PathBuf {
    let home = home();
    let file = ewe_app_core::xdg::config_home().join("user-dirs.dirs");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| parse_user_dirs(&t, name, &home))
        .unwrap_or_else(|| home.join(fallback))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_user_dirs() {
        let text = "# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_MUSIC_DIR=\"$HOME/My Music\"\nXDG_PICTURES_DIR=\"/data/pics\"\n";
        let home = std::path::Path::new("/home/me");
        assert_eq!(
            parse_user_dirs(text, "MUSIC", home),
            Some(PathBuf::from("/home/me/My Music"))
        );
        assert_eq!(
            parse_user_dirs(text, "PICTURES", home),
            Some(PathBuf::from("/data/pics"))
        );
        assert_eq!(parse_user_dirs(text, "VIDEOS", home), None);
    }
}
