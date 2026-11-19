//! `org.freedesktop.FileManager1` on the session bus: every app's "Show in folder"
//! (`ShowItems`), `ShowFolders` and `ShowItemProperties` land here as `fm1` events
//! (`{kind, paths}`), when no other file manager holds the name.

use crate::ops::Emit;

pub struct FileManager1 {
    pub emit: Emit,
}

fn paths_of(uris: Vec<String>) -> Vec<String> {
    uris.iter()
        .filter_map(|u| {
            let rest = u.strip_prefix("file://")?;
            let rest = rest.strip_prefix("localhost").unwrap_or(rest);
            if !rest.starts_with('/') {
                return None;
            }
            Some(
                percent_encoding::percent_decode_str(rest)
                    .decode_utf8_lossy()
                    .into_owned(),
            )
        })
        .collect()
}

#[zbus::interface(name = "org.freedesktop.FileManager1")]
impl FileManager1 {
    fn show_folders(&self, uris: Vec<String>, _startup_id: String) {
        (self.emit)(
            "fm1",
            serde_json::json!({ "kind": "folders", "paths": paths_of(uris) }),
        );
    }

    fn show_items(&self, uris: Vec<String>, _startup_id: String) {
        (self.emit)(
            "fm1",
            serde_json::json!({ "kind": "items", "paths": paths_of(uris) }),
        );
    }

    fn show_item_properties(&self, uris: Vec<String>, _startup_id: String) {
        (self.emit)(
            "fm1",
            serde_json::json!({ "kind": "properties", "paths": paths_of(uris) }),
        );
    }
}

/// Claim the name and serve; the connection must be kept alive by the caller.
pub async fn serve(emit: Emit) -> zbus::Result<zbus::Connection> {
    zbus::connection::Builder::session()?
        .name("org.freedesktop.FileManager1")?
        .serve_at("/org/freedesktop/FileManager1", FileManager1 { emit })?
        .build()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_uris_into_paths() {
        assert_eq!(
            paths_of(vec![
                "file:///home/me/My%20Files/a.png".into(),
                "file://localhost/x".into(),
                "https://example.com".into(),
                "trash:///".into(),
            ]),
            vec!["/home/me/My Files/a.png".to_string(), "/x".to_string()]
        );
    }
}
