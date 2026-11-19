//! Album art for an audio file: the embedded picture (lofty) or a cover image next to it.

use std::path::Path;

pub struct Cover {
    pub bytes: Vec<u8>,
    pub mime: String,
}

const SIDECARS: &[&str] = &[
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "cover.webp",
    "Cover.jpg",
    "Cover.png",
    "folder.jpg",
    "folder.jpeg",
    "folder.png",
    "Folder.jpg",
    "Folder.png",
    "front.jpg",
    "front.png",
    "album.jpg",
    "album.png",
    "AlbumArt.jpg",
    "AlbumArtSmall.jpg",
    ".folder.png",
];

fn mime_of_bytes(bytes: &[u8], fallback: &str) -> String {
    match image::guess_format(bytes) {
        Ok(f) => f.to_mime_type().to_string(),
        Err(_) => fallback.to_string(),
    }
}

/// The embedded front cover (or the first picture) of an audio file.
pub fn embedded(path: &Path) -> Option<Cover> {
    use lofty::file::TaggedFileExt;
    use lofty::picture::PictureType;
    let tagged = lofty::read_from_path(path).ok()?;
    let tags = tagged.primary_tag().into_iter().chain(tagged.tags());
    let mut first: Option<Cover> = None;
    for tag in tags {
        for pic in tag.pictures() {
            let cover = Cover {
                bytes: pic.data().to_vec(),
                mime: pic
                    .mime_type()
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| mime_of_bytes(pic.data(), "image/jpeg")),
            };
            if pic.pic_type() == PictureType::CoverFront {
                return Some(cover);
            }
            if first.is_none() {
                first = Some(cover);
            }
        }
    }
    first
}

/// A `cover.jpg`-style image in the file's folder.
pub fn sidecar(path: &Path) -> Option<Cover> {
    let dir = path.parent()?;
    for name in SIDECARS {
        let p = dir.join(name);
        if p.is_file()
            && let Ok(bytes) = std::fs::read(&p)
            && bytes.len() <= 20 * 1024 * 1024
        {
            let mime = mime_of_bytes(&bytes, "image/jpeg");
            return Some(Cover { bytes, mime });
        }
    }
    None
}

pub fn find(path: &Path) -> Option<Cover> {
    embedded(path).or_else(|| sidecar(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_is_found_next_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]));
        img.save(dir.path().join("cover.png")).unwrap();
        let track = dir.path().join("song.flac");
        std::fs::write(&track, b"not really flac").unwrap();
        let c = find(&track).expect("sidecar cover");
        assert_eq!(c.mime, "image/png");
        assert!(!c.bytes.is_empty());
        let lonely = tempfile::tempdir().unwrap();
        let t2 = lonely.path().join("x.mp3");
        std::fs::write(&t2, b"nope").unwrap();
        assert!(find(&t2).is_none());
    }
}
