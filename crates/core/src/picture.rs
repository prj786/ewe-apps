//! Pictures WebKitGTK cannot show — HEIC / HEIF, what phones save — turned into a JPEG once
//! with `heif-dec` (libheif) and kept in `$XDG_CACHE_HOME/ewe-apps/pictures/`, named by the
//! file's URI, size and mtime (a changed file gets a new one, the old one goes). The Viewer
//! shows that copy through `/picture/<name>`; its info panel still reads the original's EXIF.
//! heif-dec applies the HEIF rotation and writes EXIF orientation 1, so the copy is upright.
//!
//! Thumbnails of HEIC, AVIF and JPEG XL (none of which the `image` crate decodes) go through
//! the same tools into a temporary file: `heif-dec` for HEIC/HEIF/AVIF (libheif reads AV1
//! through dav1d), `djxl` (libjxl, which WebKitGTK itself depends on) for JPEG XL, ImageMagick
//! when it is there and the others are not. The cache stays under [`CACHE_LIMIT`], oldest first.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use md5::{Digest, Md5};

use crate::xdg::file_uri;

/// Pictures that are converted for viewing: WebKitGTK 2.54 has AVIF and JPEG XL decoders
/// (libavif, libjxl) but no HEIF one.
pub const VIEW_CONVERTED: &[&str] = &["heic", "heif", "hif"];
/// Pictures whose thumbnails need an outside decoder.
pub const THUMB_CONVERTED: &[&str] = &["heic", "heif", "hif", "avif", "jxl"];
/// The converted copies are pruned to 80 % of this, oldest first.
pub const CACHE_LIMIT: u64 = 512 * 1024 * 1024;
/// A decoder that takes longer than this is stopped (a broken file must not hang a request).
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn needs_conversion(path: &Path) -> bool {
    VIEW_CONVERTED.contains(&ext_of(path).as_str())
}

pub fn thumb_needs_conversion(path: &Path) -> bool {
    THUMB_CONVERTED.contains(&ext_of(path).as_str())
}

/// `$XDG_CACHE_HOME/ewe-apps/pictures` next to `$XDG_CACHE_HOME/thumbnails`.
pub fn root_beside(thumbnails: &Path) -> PathBuf {
    thumbnails
        .parent()
        .unwrap_or(Path::new("/tmp"))
        .join("ewe-apps")
        .join("pictures")
}

fn key_of(path: &Path) -> String {
    hex::encode(Md5::digest(file_uri(path).as_bytes()))
}

/// `<root>/<md5 of the URI>-<size>-<mtime ns>.jpg`
pub fn cache_file(root: &Path, path: &Path, meta: &std::fs::Metadata) -> PathBuf {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    root.join(format!("{}-{:x}-{mtime:x}.jpg", key_of(path), meta.len()))
}

pub(crate) fn on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

/// Run a decoder with a time limit; true when it exited 0.
fn run(mut cmd: Command) -> bool {
    let Ok(mut child) = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() < TOOL_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Decode `src` into `dst` (its extension picks JPEG or PNG) with whatever is installed.
pub fn convert(src: &Path, dst: &Path) -> bool {
    let dir = dst.parent().unwrap_or(Path::new("/tmp"));
    let ext = ext_of(src);
    if matches!(ext.as_str(), "heic" | "heif" | "hif" | "avif")
        && let Some(tool) = on_path("heif-dec")
    {
        let mut cmd = Command::new(tool);
        cmd.arg("--quiet").arg("-q").arg("92").arg(src).arg(dst);
        if run(cmd) && settle(dst, dir) {
            return true;
        }
    }
    if ext == "jxl"
        && let Some(tool) = on_path("djxl")
    {
        let mut cmd = Command::new(tool);
        cmd.arg(src).arg(dst).arg("--quiet");
        if run(cmd) && dst.is_file() {
            return true;
        }
    }
    if ext == "avif"
        && let Some(tool) = on_path("avifdec")
    {
        let mut cmd = Command::new(tool);
        cmd.arg(src).arg(dst);
        if run(cmd) && dst.is_file() {
            return true;
        }
    }
    if let Some(tool) = on_path("magick") {
        // `[0]`: the first frame / the primary image only
        let mut source = src.as_os_str().to_owned();
        source.push("[0]");
        let mut cmd = Command::new(tool);
        cmd.arg(source).arg("-auto-orient").arg(dst);
        if run(cmd) && dst.is_file() {
            return true;
        }
    }
    false
}

/// heif-dec numbers its outputs (`x-1.jpg`, `x-2.jpg`) when a file holds several top-level
/// pictures (a burst): the first one is the one we show.
fn settle(dst: &Path, dir: &Path) -> bool {
    if dst.is_file() {
        return true;
    }
    let (Some(stem), Some(ext)) = (
        dst.file_stem().and_then(|s| s.to_str()),
        dst.extension().and_then(|e| e.to_str()),
    ) else {
        return false;
    };
    let mut numbered: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&format!("{stem}-")) && n.ends_with(&format!(".{ext}")))
                .unwrap_or(false)
        })
        .collect();
    numbered.sort();
    let Some(first) = numbered.first() else {
        return false;
    };
    let ok = std::fs::rename(first, dst).is_ok();
    for other in numbered.iter().skip(1) {
        let _ = std::fs::remove_file(other);
    }
    ok
}

fn temp_dir_in(parent: &Path) -> Option<PathBuf> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).ok()?;
    let dir = parent.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        hex::encode(bytes)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The viewable copy of `path` (made now when there is none): a JPEG in `root`.
pub fn converted(root: &Path, path: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let target = cache_file(root, path, &meta);
    if target.is_file() {
        // recently used: last to be pruned
        if let Ok(f) = std::fs::File::options().write(true).open(&target) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
        return Some(target);
    }
    create_private_dir(root).ok()?;
    let tmp = temp_dir_in(root)?;
    let out = tmp.join("picture.jpg");
    let ok = convert(path, &out) && std::fs::rename(&out, &target).is_ok();
    let _ = std::fs::remove_dir_all(&tmp);
    if !ok {
        return None;
    }
    // older copies of the same file (it was edited since)
    let key = key_of(path);
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            if p != target && name.starts_with(&format!("{key}-")) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    prune(root, CACHE_LIMIT);
    Some(target)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

/// Remove the least recently used copies until the folder is under 80 % of `limit`.
pub fn prune(root: &Path, limit: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= limit {
        return;
    }
    files.sort();
    let goal = limit / 10 * 8;
    for (_, len, p) in files {
        if total <= goal {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// A picture the `image` crate cannot read, decoded for a thumbnail: the viewable copy when
/// the Viewer already made one, else a temporary PNG.
pub fn decode_for_thumbnail(root: &Path, path: &Path) -> Option<image::DynamicImage> {
    if needs_conversion(path)
        && let Ok(meta) = std::fs::metadata(path)
    {
        let cached = cache_file(root, path, &meta);
        if cached.is_file()
            && let Ok(img) = image::open(&cached)
        {
            return Some(img);
        }
    }
    let tmp = temp_dir_in(&std::env::temp_dir())?;
    let out = tmp.join("thumb.png");
    let img = if convert(path, &out) {
        image::open(&out).ok()
    } else {
        None
    };
    let _ = std::fs::remove_dir_all(&tmp);
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/pictures")
            .join(name)
    }

    #[test]
    fn which_need_converting() {
        assert!(needs_conversion(Path::new("/p/IMG_0001.HEIC")));
        assert!(needs_conversion(Path::new("/p/a.heif")));
        assert!(!needs_conversion(Path::new("/p/a.avif")));
        assert!(!needs_conversion(Path::new("/p/a.jpg")));
        assert!(thumb_needs_conversion(Path::new("/p/a.jxl")));
        assert!(thumb_needs_conversion(Path::new("/p/a.avif")));
        assert!(!thumb_needs_conversion(Path::new("/p/a.png")));
        assert_eq!(
            root_beside(Path::new("/home/me/.cache/thumbnails")),
            PathBuf::from("/home/me/.cache/ewe-apps/pictures")
        );
    }

    #[test]
    fn heic_becomes_an_upright_cached_jpeg() {
        if on_path("heif-dec").is_none() {
            eprintln!("heif-dec not installed: skipped");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // a copy, so the cache key is ours and the mtime can change
        let src = dir.path().join("IMG_0001.heic");
        std::fs::copy(fixture("rotated.heic"), &src).unwrap();
        let root = dir.path().join("pictures");
        let out = converted(&root, &src).expect("converted");
        assert!(out.starts_with(&root));
        let img = image::open(&out).unwrap();
        // stored 960×720 with a 270° HEIF rotation: shown 720×960
        assert_eq!((img.width(), img.height()), (720, 960));
        // the fixture's yellow band was at the top of the stored picture; turned a quarter
        // clockwise (EXIF orientation 6 became the HEIF rotation) it is on the right
        let rgb = img.to_rgb8();
        let yellow = |x, y| {
            let [r, g, b] = rgb.get_pixel(x, y).0;
            r > 200 && g > 150 && b < 120
        };
        assert!(yellow(700, 480) && !yellow(20, 480) && !yellow(360, 20));
        // the second time it is the same file
        assert_eq!(converted(&root, &src), Some(out.clone()));
        // edited: a new copy, the old one is gone
        std::thread::sleep(Duration::from_millis(20));
        std::fs::copy(fixture("rotated.heic"), &src).unwrap();
        let f = std::fs::File::options().write(true).open(&src).unwrap();
        f.set_modified(std::time::SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        let again = converted(&root, &src).unwrap();
        assert_ne!(again, out);
        assert!(!out.exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        // the thumbnail path reuses it
        let thumb = decode_for_thumbnail(&root, &src).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (720, 960));
    }

    #[test]
    fn avif_and_jxl_thumbnails() {
        let dir = tempfile::tempdir().unwrap();
        for (name, tool) in [("photo.avif", "heif-dec"), ("photo.jxl", "djxl")] {
            if on_path(tool).is_none() && on_path("magick").is_none() {
                eprintln!("{tool} not installed: {name} skipped");
                continue;
            }
            let img = decode_for_thumbnail(dir.path(), &fixture(name)).expect(name);
            assert_eq!((img.width(), img.height()), (960, 720), "{name}");
        }
        // nothing converted for the view, nothing cached
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        // not a picture at all
        let bogus = dir.path().join("broken.heic");
        std::fs::write(&bogus, b"not a heif file").unwrap();
        assert!(converted(&dir.path().join("pictures"), &bogus).is_none());
    }

    #[test]
    fn prunes_the_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::now();
        for (i, name) in ["old", "mid", "new"].iter().enumerate() {
            let p = dir.path().join(name);
            std::fs::write(&p, vec![0u8; 1000]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(now - Duration::from_secs(100 - i as u64 * 10))
                .unwrap();
        }
        prune(dir.path(), 3000);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
        prune(dir.path(), 2500);
        assert!(!dir.path().join("old").exists());
        assert!(dir.path().join("mid").exists() && dir.path().join("new").exists());
    }
}
