//! The freedesktop thumbnail cache (`$XDG_CACHE_HOME/thumbnails/{normal,large,x-large}`),
//! read first so Nemo's and the browser's thumbnails are reused, written per the
//! Thumbnail Managing Standard: `<md5 of the file URI>.png`, `Thumb::URI` and
//! `Thumb::MTime` text chunks, a temp file renamed into place, 0700 dirs, 0600 files.
//! Images go through the `image` crate (EXIF orientation applied), videos through
//! `ffmpegthumbnailer` when it is on the PATH, audio through the embedded cover, HEIC /
//! AVIF / JPEG XL through `heif-dec` / `djxl` ([`crate::picture`]).
//! At most three generations run at once.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use md5::{Digest, Md5};
use tokio::sync::Semaphore;

use crate::xdg::file_uri;

pub const MAX_PARALLEL: usize = 3;

/// The cache folders of the spec, smallest first.
pub const SIZES: &[(&str, u32)] = &[
    ("normal", 128),
    ("large", 256),
    ("x-large", 512),
    ("xx-large", 1024),
];

/// The spec folder a requested pixel size maps to (the smallest that is not smaller).
pub fn size_dir(size: u32) -> (&'static str, u32) {
    for (name, px) in SIZES {
        if size <= *px {
            return (name, *px);
        }
    }
    SIZES[SIZES.len() - 1]
}

pub fn file_name_for(path: &Path) -> String {
    let uri = file_uri(path);
    format!("{}.png", hex::encode(Md5::digest(uri.as_bytes())))
}

/// `<cache root>/<dir>/<md5>.png`
pub fn cache_path(root: &Path, dir: &str, path: &Path) -> PathBuf {
    root.join(dir).join(file_name_for(path))
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `Thumb::MTime` of a cached PNG, read from its text chunks without decoding pixels.
pub fn thumb_mtime(png_path: &Path) -> Option<i64> {
    let file = std::fs::File::open(png_path).ok()?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let reader = decoder.read_info().ok()?;
    let info = reader.info();
    for chunk in &info.uncompressed_latin1_text {
        if chunk.keyword == "Thumb::MTime" {
            return chunk.text.trim().parse().ok();
        }
    }
    for chunk in &info.utf8_text {
        if chunk.keyword == "Thumb::MTime" {
            return chunk.get_text().ok()?.trim().parse().ok();
        }
    }
    None
}

/// A fresh cached thumbnail for `path` of at least `size` px, if one exists.
pub fn find_cached(root: &Path, path: &Path, size: u32, mtime: i64) -> Option<PathBuf> {
    let (want, _) = size_dir(size);
    let start = SIZES.iter().position(|(n, _)| *n == want)?;
    for (dir, _) in &SIZES[start..] {
        let p = cache_path(root, dir, path);
        if p.is_file() && thumb_mtime(&p) == Some(mtime) {
            return Some(p);
        }
    }
    None
}

#[derive(Clone)]
pub struct Thumbs {
    root: Arc<PathBuf>,
    sem: Arc<Semaphore>,
}

impl Thumbs {
    /// `root` is the `thumbnails` directory (normally `$XDG_CACHE_HOME/thumbnails`).
    pub fn new(root: PathBuf) -> Thumbs {
        Thumbs {
            root: Arc::new(root),
            sem: Arc::new(Semaphore::new(MAX_PARALLEL)),
        }
    }

    /// The `thumbnails` directory this cache writes to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn default_root() -> PathBuf {
        crate::xdg::cache_home().join("thumbnails")
    }

    /// PNG bytes of a thumbnail for `path`, from the cache or freshly made.
    pub async fn get(&self, path: PathBuf, size: u32) -> Option<Vec<u8>> {
        let meta = tokio::fs::metadata(&path).await.ok()?;
        if !meta.is_file() {
            return None;
        }
        let mtime = mtime_secs(&meta);
        let root = self.root.clone();
        let cached = {
            let (root, path) = (root.clone(), path.clone());
            tokio::task::spawn_blocking(move || find_cached(&root, &path, size, mtime))
                .await
                .ok()?
        };
        if let Some(p) = cached {
            return tokio::fs::read(p).await.ok();
        }
        let _permit = self.sem.acquire().await.ok()?;
        tokio::task::spawn_blocking(move || generate(&root, &path, size, mtime))
            .await
            .ok()?
    }
}

fn kind_of(path: &Path) -> &'static str {
    if crate::picture::thumb_needs_conversion(path) {
        return "converted";
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "ico" | "qoi" => "image",
        "mp4" | "m4v" | "mkv" | "webm" | "mov" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "3gp"
        | "m2ts" | "ts" | "ogv" => "video",
        "mp3" | "flac" | "ogg" | "oga" | "opus" | "wav" | "m4a" | "aac" | "wma" | "aiff"
        | "mka" => "audio",
        _ => "other",
    }
}

/// Make the thumbnail, store it in the spec folder and return its bytes.
pub fn generate(root: &Path, path: &Path, size: u32, mtime: i64) -> Option<Vec<u8>> {
    let (dir, px) = size_dir(size);
    let img = match kind_of(path) {
        "image" => load_image(path)?,
        "converted" => {
            crate::picture::decode_for_thumbnail(&crate::picture::root_beside(root), path)?
        }
        "video" => video_frame(path, px)?,
        "audio" => {
            let cover = crate::cover::find(path)?;
            image::load_from_memory(&cover.bytes).ok()?
        }
        _ => return None,
    };
    let thumb = img.thumbnail(px, px).to_rgba8();
    let bytes = encode_png(&thumb, &file_uri(path), mtime)?;
    let target = cache_path(root, dir, path);
    let _ = write_atomic(&target, &bytes);
    Some(bytes)
}

fn load_image(path: &Path) -> Option<image::DynamicImage> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
    img.apply_orientation(orientation);
    Some(img)
}

fn video_frame(path: &Path, px: u32) -> Option<image::DynamicImage> {
    let tool = crate::picture::on_path("ffmpegthumbnailer")?;
    let tmp = std::env::temp_dir().join(format!(
        "ewe-apps-thumb-{}-{}.png",
        std::process::id(),
        hex::encode(Md5::digest(path.as_os_str().as_encoded_bytes()))
    ));
    let status = std::process::Command::new(tool)
        .arg("-i")
        .arg(path)
        .arg("-o")
        .arg(&tmp)
        .arg("-s")
        .arg(px.to_string())
        .arg("-c")
        .arg("png")
        .arg("-q")
        .arg("8")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    let out = if status.success() {
        image::open(&tmp).ok()
    } else {
        None
    };
    let _ = std::fs::remove_file(&tmp);
    out
}

/// A PNG with the spec's text chunks.
pub fn encode_png(img: &image::RgbaImage, uri: &str, mtime: i64) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width(), img.height());
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.add_text_chunk("Thumb::URI".into(), uri.into()).ok()?;
        enc.add_text_chunk("Thumb::MTime".into(), mtime.to_string())
            .ok()?;
        enc.add_text_chunk("Software".into(), "ewe-apps".into())
            .ok()?;
        let mut w = enc.write_header().ok()?;
        w.write_image_data(img.as_raw()).ok()?;
    }
    Some(out)
}

fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = target.parent().expect("cache path has a parent");
    if !dir.is_dir() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    let tmp = dir.join(format!(
        "{}.{}.tmp",
        target.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        std::io::Write::write_all(&mut f, bytes)?;
    }
    std::fs::rename(&tmp, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_follow_the_spec() {
        // md5("file:///home/jens/photos/me.png") per the Thumbnail Managing Standard
        assert_eq!(
            file_name_for(Path::new("/home/jens/photos/me.png")),
            "c6ee772d9e49320e97ec29a7eb5b1697.png"
        );
        assert_eq!(size_dir(128), ("normal", 128));
        assert_eq!(size_dir(200), ("large", 256));
        assert_eq!(size_dir(512), ("x-large", 512));
        assert_eq!(size_dir(4000), ("xx-large", 1024));
        assert_eq!(
            cache_path(
                Path::new("/c"),
                "large",
                Path::new("/home/jens/photos/me.png")
            ),
            PathBuf::from("/c/large/c6ee772d9e49320e97ec29a7eb5b1697.png")
        );
    }

    #[tokio::test]
    async fn generates_reads_back_and_refreshes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("pic.png");
        let img = image::RgbaImage::from_fn(640, 400, |x, _| {
            image::Rgba([(x % 256) as u8, 40, 200, 255])
        });
        img.save(&src).unwrap();
        let root = dir.path().join("thumbnails");
        let thumbs = Thumbs::new(root.clone());

        let png = thumbs.get(src.clone(), 128).await.expect("thumbnail");
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!(decoded.width(), 128);
        assert_eq!(decoded.height(), 80);
        let cached = cache_path(&root, "normal", &src);
        assert!(cached.is_file());
        let mtime = mtime_secs(&std::fs::metadata(&src).unwrap());
        assert_eq!(thumb_mtime(&cached), Some(mtime));
        assert_eq!(find_cached(&root, &src, 128, mtime), Some(cached.clone()));
        // a larger request is not satisfied by the small one
        assert_eq!(find_cached(&root, &src, 256, mtime), None);
        // a stale one (other mtime) is not used
        assert_eq!(find_cached(&root, &src, 128, mtime + 1), None);
        // a cached larger size serves a smaller request
        let big = thumbs.get(src.clone(), 512).await.unwrap();
        assert!(cache_path(&root, "x-large", &src).is_file());
        assert_eq!(
            find_cached(&root, &src, 200, mtime),
            Some(cache_path(&root, "x-large", &src))
        );
        assert!(big.len() > png.len());
        // a phone picture (HEIC, turned by its HEIF rotation) when heif-dec is there
        if crate::picture::on_path("heif-dec").is_some() {
            let heic = dir.path().join("IMG_0001.HEIC");
            std::fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pictures/rotated.heic"),
                &heic,
            )
            .unwrap();
            let png = thumbs.get(heic.clone(), 128).await.expect("heic thumbnail");
            let decoded = image::load_from_memory(&png).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (96, 128));
            assert!(cache_path(&root, "normal", &heic).is_file());
        }
        // not an image: nothing
        let txt = dir.path().join("a.txt");
        std::fs::write(&txt, "hi").unwrap();
        assert!(thumbs.get(txt, 128).await.is_none());
    }
}
