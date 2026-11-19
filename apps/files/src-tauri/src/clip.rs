//! The system clipboard for files (main thread, GTK): `x-special/gnome-copied-files`
//! (`copy\nfile:///a\nfile:///b` — what Nemo, Nautilus and ewe Browser read and
//! write) plus `text/uri-list` and plain text for everything else.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Clip {
    pub mode: String,
    pub paths: Vec<String>,
}

const GNOME: &str = "x-special/gnome-copied-files";

pub fn encode(mode: &str, paths: &[String]) -> String {
    let mut out = String::from(mode);
    for p in paths {
        out.push('\n');
        out.push_str(&ewe_app_core::xdg::file_uri(std::path::Path::new(p)));
    }
    out
}

pub fn decode(text: &str) -> Option<Clip> {
    let mut lines = text.lines();
    let mode = lines.next()?.trim();
    let mode = match mode {
        "copy" | "cut" => mode.to_string(),
        _ => return None,
    };
    let paths = uris_to_paths(lines);
    (!paths.is_empty()).then_some(Clip { mode, paths })
}

fn uris_to_paths<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<String> {
    lines
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("file://")?;
            let rest = rest.strip_prefix("localhost").unwrap_or(rest);
            rest.starts_with('/').then(|| {
                percent_encoding::percent_decode_str(rest)
                    .decode_utf8_lossy()
                    .into_owned()
            })
        })
        .collect()
}

pub fn set(mode: &str, paths: Vec<String>) -> bool {
    let Some(clipboard) =
        gtk::Clipboard::default(&gdk::Display::default().unwrap_or_else(|| panic!("no display")))
    else {
        return false;
    };
    let gnome = encode(mode, &paths);
    let uris: String = paths
        .iter()
        .map(|p| ewe_app_core::xdg::file_uri(std::path::Path::new(p)))
        .collect::<Vec<_>>()
        .join("\r\n");
    let plain = paths.join("\n");
    let targets = [
        gtk::TargetEntry::new(GNOME, gtk::TargetFlags::empty(), 0),
        gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 1),
        gtk::TargetEntry::new("text/plain;charset=utf-8", gtk::TargetFlags::empty(), 2),
        gtk::TargetEntry::new("UTF8_STRING", gtk::TargetFlags::empty(), 3),
    ];
    clipboard.set_with_data(&targets, move |_cb, selection, info| {
        let text = match info {
            0 => &gnome,
            1 => &uris,
            _ => &plain,
        };
        if info <= 1 {
            selection.set(&selection.target(), 8, text.as_bytes());
        } else {
            selection.set_text(text);
        }
    })
}

pub fn get() -> Option<Clip> {
    let clipboard = gtk::Clipboard::default(&gdk::Display::default()?)?;
    if let Some(data) = clipboard.wait_for_contents(&gdk::Atom::intern(GNOME))
        && let Some(c) = decode(&String::from_utf8_lossy(&data.data()))
    {
        return Some(c);
    }
    let uris = clipboard.wait_for_uris();
    let paths = uris_to_paths(uris.iter().map(|u| u.as_str()));
    (!paths.is_empty()).then_some(Clip {
        mode: "copy".into(),
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes_gnome_copied_files() {
        let text = encode("cut", &["/home/me/a b.txt".into(), "/x".into()]);
        assert_eq!(text, "cut\nfile:///home/me/a%20b.txt\nfile:///x");
        let c = decode(&text).unwrap();
        assert_eq!(c.mode, "cut");
        assert_eq!(c.paths, vec!["/home/me/a b.txt", "/x"]);
        assert!(decode("nope\nfile:///x").is_none());
        assert!(decode("copy\n").is_none());
    }
}
