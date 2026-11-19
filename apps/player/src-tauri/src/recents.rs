//! What ewe Player opened before, from `recently-used.xbel` (the core writes it through
//! `add_recent`; this reads back our own entries for the start screen).

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub mime: Option<String>,
    /// RFC 3339 stamp of the last open
    pub modified: String,
}

pub const MAX_ITEMS: usize = 40;

/// Our bookmarks, newest first, only those whose file still exists.
pub fn list(xbel_text: &str, app_name: &str, exists: impl Fn(&Path) -> bool) -> Vec<RecentItem> {
    let mut items: Vec<RecentItem> = ewe_app_core::recent::parse(xbel_text)
        .into_iter()
        .filter(|b| b.applications.iter().any(|a| a.name == app_name))
        .filter_map(|b| {
            let rest = b.href.strip_prefix("file://")?;
            let rest = rest.strip_prefix("localhost").unwrap_or(rest);
            let path = percent_encoding::percent_decode_str(rest)
                .decode_utf8()
                .ok()?
                .into_owned();
            if !path.starts_with('/') || !exists(Path::new(&path)) {
                return None;
            }
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            Some(RecentItem {
                path,
                name,
                mime: b.mime.clone(),
                modified: b.modified.clone(),
            })
        })
        .collect();
    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    items.truncate(MAX_ITEMS);
    items
}

pub fn read(app_name: &str) -> Vec<RecentItem> {
    let text = std::fs::read_to_string(ewe_app_core::recent::xbel_path()).unwrap_or_default();
    list(&text, app_name, |p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_our_existing_files_newest_first() {
        let xbel = r#"<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks" xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
  <bookmark href="file:///v/Old%20Clip.mp4" added="2026-11-01T10:00:00.000000Z" modified="2026-11-01T10:00:00.000000Z" visited="2026-11-01T10:00:00.000000Z">
    <info><metadata owner="http://freedesktop.org"><mime:mime-type type="video/mp4"/><bookmark:applications><bookmark:application name="ewe Player" exec="&apos;ewe-player %u&apos;" modified="2026-11-01T10:00:00.000000Z" count="1"/></bookmark:applications></metadata></info>
  </bookmark>
  <bookmark href="file:///v/New%20Clip.mkv" added="2026-11-02T10:00:00.000000Z" modified="2026-11-02T10:00:00.000000Z" visited="2026-11-02T10:00:00.000000Z">
    <info><metadata owner="http://freedesktop.org"><bookmark:applications><bookmark:application name="ewe Player" exec="&apos;ewe-player %u&apos;" modified="2026-11-02T10:00:00.000000Z" count="2"/></bookmark:applications></metadata></info>
  </bookmark>
  <bookmark href="file:///d/doc.pdf" added="2026-11-03T10:00:00.000000Z" modified="2026-11-03T10:00:00.000000Z" visited="2026-11-03T10:00:00.000000Z">
    <info><metadata owner="http://freedesktop.org"><bookmark:applications><bookmark:application name="ewe Viewer" exec="&apos;ewe-viewer %u&apos;" modified="2026-11-03T10:00:00.000000Z" count="1"/></bookmark:applications></metadata></info>
  </bookmark>
  <bookmark href="file:///v/Gone.mp4" added="2026-11-04T10:00:00.000000Z" modified="2026-11-04T10:00:00.000000Z" visited="2026-11-04T10:00:00.000000Z">
    <info><metadata owner="http://freedesktop.org"><bookmark:applications><bookmark:application name="ewe Player" exec="&apos;ewe-player %u&apos;" modified="2026-11-04T10:00:00.000000Z" count="1"/></bookmark:applications></metadata></info>
  </bookmark>
</xbel>
"#;
        let got = list(xbel, "ewe Player", |p| !p.ends_with("Gone.mp4"));
        let names: Vec<&str> = got.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["New Clip.mkv", "Old Clip.mp4"]);
        assert_eq!(got[1].mime.as_deref(), Some("video/mp4"));
        assert_eq!(got[0].path, "/v/New Clip.mkv");
    }
}
