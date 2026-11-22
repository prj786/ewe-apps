//! eep cards: `<Name>.eep`, a small TOML file (`application/x-eep`) that IS an app in
//! `~/Applications` (the contract: `eep/docs/CARD.md`). ewe Files shows a card as its
//! app — the card's `name`, no `.eep`, and the icon embedded in it — wherever the card
//! sits. Read only: nothing here ever writes a card (eep does).
//!
//! [`card`] is what a listing row carries, cached per path + size + mtime so a folder
//! that is listed again (every `fs-changed`) reads no card twice; [`read_icon`] decodes
//! the embedded icon for the media server's `/app-icon` route. An unreadable card is
//! simply not an app: the caller shows the file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

/// The largest card read at all: a 96 KB icon is 128 KB of base64, the rest is small.
pub const MAX_CARD_BYTES: u64 = 256 * 1024;
/// The largest icon a card carries (decoded bytes; eep's `ICON_MAX`).
pub const ICON_MAX: usize = 96 * 1024;
const ICON_B64_MAX: usize = ICON_MAX.div_ceil(3) * 4;
/// Cached cards; past this the cache starts over (a listing refills what it shows).
const CACHE_MAX: usize = 4096;

/// What a listing row shows of a card.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppCard {
    /// the display name (the card's `name`; never the file name)
    pub name: String,
    pub id: String,
    /// empty when the card has none
    pub version: String,
    /// `gui` | `cli` | `tool` (eep's), empty when the card has none
    pub kind: String,
    /// the card embeds an icon (`/app-icon` serves it)
    pub icon: bool,
}

/// The fields Files reads; every other field of the card is eep's and ignored.
#[derive(Deserialize)]
struct Raw {
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    kind: Option<String>,
    icon_type: Option<String>,
    icon_data: Option<String>,
}

/// An embedded icon: its type and the decoded bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Icon {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// `Firefox.eep`, `x.EEP` — not `.eep` alone. Byte-wise, so any UTF-8 name is safe.
pub fn is_card_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() > 4 && b[b.len() - 4..].eq_ignore_ascii_case(b".eep")
}

fn icon_mime(icon_type: Option<&str>) -> Option<&'static str> {
    match icon_type? {
        "image/png" => Some("image/png"),
        "image/svg+xml" => Some("image/svg+xml"),
        _ => None,
    }
}

fn text(v: Option<String>) -> String {
    v.map(|s| s.trim().to_string()).unwrap_or_default()
}

fn raw(text: &str) -> Option<Raw> {
    toml::from_str::<Raw>(text).ok()
}

/// A card's text → what a row shows; `None` when it is no card (bad TOML, no `id` or
/// `name`).
pub fn parse(card_text: &str) -> Option<AppCard> {
    let r = raw(card_text)?;
    let id = text(r.id);
    let name = text(r.name);
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let icon = icon_mime(r.icon_type.as_deref()).is_some()
        && r.icon_data
            .as_deref()
            .is_some_and(|d| !d.trim().is_empty() && d.len() <= ICON_B64_MAX + 4);
    Some(AppCard {
        name,
        id,
        version: text(r.version),
        kind: text(r.kind),
        icon,
    })
}

/// The embedded icon of a card's text: a PNG that starts like one, or an SVG.
pub fn parse_icon(card_text: &str) -> Option<Icon> {
    use base64::Engine;
    let r = raw(card_text)?;
    let mime = icon_mime(r.icon_type.as_deref())?;
    let data = r.icon_data?;
    let data = data.trim();
    if data.len() > ICON_B64_MAX + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    if bytes.is_empty() || bytes.len() > ICON_MAX {
        return None;
    }
    let looks_right = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        _ => bytes.windows(4).any(|w| w == b"<svg"),
    };
    looks_right.then_some(Icon { mime, bytes })
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CARD_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The decoded icon of the card at `path`.
pub fn read_icon(path: &Path) -> Option<Icon> {
    if !is_card_name(&path.file_name()?.to_string_lossy()) {
        return None;
    }
    parse_icon(&read_text(path)?)
}

/// Size, mtime (ns) and inode: a card that changed in any way is read again.
type Stamp = (u64, u128, u64);

fn stamp(meta: &std::fs::Metadata) -> Stamp {
    use std::os::unix::fs::MetadataExt;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (meta.len(), mtime, meta.ino())
}

/// path → (what it was when read, the app or `None` for a broken card)
type Cache = HashMap<PathBuf, (Stamp, Option<AppCard>)>;

static CARDS: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The app a card at `path` is (through a symlink too), or `None` for any other file
/// and for a card that cannot be read. Cached per path, size and mtime.
pub fn card(path: &Path) -> Option<AppCard> {
    if !is_card_name(&path.file_name()?.to_string_lossy()) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CARD_BYTES {
        return None;
    }
    let key = stamp(&meta);
    if let Some((k, v)) = CARDS.lock().ok()?.get(path)
        && *k == key
    {
        return v.clone();
    }
    let value = std::fs::read_to_string(path).ok().and_then(|t| parse(&t));
    if let Ok(mut cache) = CARDS.lock() {
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (key, value.clone()));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn firefox(extra: &str) -> String {
        format!(
            "eep = 0\nid = \"firefox\"\nname = \"Firefox\"\nkind = \"gui\"\nversion = \"160.0.1\"\n\
             out = \"/nix/store/x-firefox\"\ninstalled = 2026-11-21T15:12:40Z\nbin = [\"firefox\"]\n{extra}"
        )
    }

    #[test]
    fn names() {
        assert!(is_card_name("Firefox.eep"));
        assert!(is_card_name("x.EEP"));
        assert!(is_card_name("Фото.eep"));
        assert!(!is_card_name(".eep"));
        assert!(!is_card_name("firefox.eep.txt"));
        assert!(!is_card_name("ёeep"));
        assert!(!is_card_name("eep"));
    }

    #[test]
    fn reads_name_and_icon() {
        let text = firefox(&format!(
            "icon_type = \"image/png\"\nicon_data = \"{PNG_1PX}\"\n"
        ));
        assert_eq!(
            parse(&text),
            Some(AppCard {
                name: "Firefox".into(),
                id: "firefox".into(),
                version: "160.0.1".into(),
                kind: "gui".into(),
                icon: true,
            })
        );
        let icon = parse_icon(&text).unwrap();
        assert_eq!(icon.mime, "image/png");
        assert!(icon.bytes.starts_with(b"\x89PNG"));

        let svg = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        );
        let text = firefox(&format!(
            "icon_type = \"image/svg+xml\"\nicon_data = \"{svg}\"\n"
        ));
        assert_eq!(parse_icon(&text).unwrap().mime, "image/svg+xml");
    }

    #[test]
    fn no_icon_is_still_an_app() {
        let card = parse(&firefox("")).unwrap();
        assert_eq!(card.name, "Firefox");
        assert!(!card.icon);
        assert!(parse_icon(&firefox("")).is_none());
        // a type eep does not embed, or data that is not what it says: no icon
        let xpm = firefox(&format!(
            "icon_type = \"image/x-xpm\"\nicon_data = \"{PNG_1PX}\"\n"
        ));
        assert!(!parse(&xpm).unwrap().icon);
        assert!(parse_icon(&xpm).is_none());
        let fake = firefox("icon_type = \"image/png\"\nicon_data = \"bm90IGEgcG5n\"\n");
        assert!(parse(&fake).unwrap().icon, "checked when served");
        assert!(parse_icon(&fake).is_none());
        let garbage = firefox("icon_type = \"image/png\"\nicon_data = \"%%%\"\n");
        assert!(parse_icon(&garbage).is_none());
        let huge = firefox(&format!(
            "icon_type = \"image/png\"\nicon_data = \"{}\"\n",
            "A".repeat(ICON_B64_MAX + 8)
        ));
        assert!(!parse(&huge).unwrap().icon);
        assert!(parse_icon(&huge).is_none());
    }

    #[test]
    fn broken_cards_are_no_apps() {
        assert!(parse("").is_none());
        assert!(parse("this is = = not toml").is_none());
        assert!(parse("id = \"x\"\n").is_none(), "no name");
        assert!(parse("name = \"X\"\n").is_none(), "no id");
        assert!(parse("id = \"x\"\nname = \"   \"\n").is_none());
        assert!(parse("id = \"x\"\nname = 7\n").is_none());
        // unknown fields and a newer format version are fine
        let newer = parse("eep = 3\nid = \"x\"\nname = \" X \"\nsomething = { a = 1 }\n").unwrap();
        assert_eq!((newer.name.as_str(), newer.version.as_str()), ("X", ""));
    }

    #[test]
    fn cached_per_path_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Firefox.eep");
        std::fs::write(&path, firefox("")).unwrap();
        assert_eq!(card(&path).unwrap().name, "Firefox");
        // rewritten (new size): read again
        std::fs::write(
            &path,
            firefox("").replace("\"Firefox\"", "\"Firefox Nightly\""),
        )
        .unwrap();
        assert_eq!(card(&path).unwrap().name, "Firefox Nightly");
        std::fs::write(&path, "broken = = =").unwrap();
        assert!(card(&path).is_none());
        // another extension, a folder, a link to a card
        let txt = dir.path().join("Firefox.txt");
        std::fs::write(&txt, firefox("")).unwrap();
        assert!(card(&txt).is_none());
        std::fs::create_dir(dir.path().join("Dir.eep")).unwrap();
        assert!(card(&dir.path().join("Dir.eep")).is_none());
        let real = dir.path().join("real.eep");
        std::fs::write(&real, firefox("")).unwrap();
        let link = dir.path().join("Link.eep");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(card(&link).unwrap().id, "firefox");
        // too big to be a card
        let big = dir.path().join("Big.eep");
        std::fs::write(&big, vec![b'#'; MAX_CARD_BYTES as usize + 1]).unwrap();
        assert!(card(&big).is_none());
        assert!(read_icon(&big).is_none());
    }

    #[test]
    fn sample_cards_from_the_eep_build() {
        // the real cards eep-build makes, when the eep checkout sits next to this repo
        let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../eep/dist");
        let Ok(releases) = std::fs::read_dir(&dist) else {
            return;
        };
        for release in releases.flatten() {
            let Ok(cards) = std::fs::read_dir(release.path().join("cards")) else {
                continue;
            };
            for c in cards.flatten() {
                let p = c.path();
                let app = card(&p).unwrap_or_else(|| panic!("{} is a card", p.display()));
                assert!(!app.name.ends_with(".eep"));
                if app.icon {
                    assert!(read_icon(&p).is_some(), "{} icon decodes", p.display());
                }
            }
        }
    }
}
