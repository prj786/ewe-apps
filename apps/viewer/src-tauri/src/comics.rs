//! Comic book archives: which entries are pages, in what order, and how to get one out.
//! CBZ (zip) is read in-process; CBR, CB7 and CBT go through `bsdtar`, then `7z`,
//! then `unar` (whichever is installed and understands the file).

use std::cmp::Ordering;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

const PAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "jxl",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicListing {
    /// entry names in reading order
    pub pages: Vec<String>,
    /// "zip", "bsdtar", "7z" or "unar": how the pages are read
    pub source: String,
}

/// Natural order: digit runs compare by value ("page 2" < "page 10"), the rest
/// case-insensitively, ties broken by the raw string so the order is total.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut xs = String::new();
                let mut ys = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    xs.push(c);
                    ai.next();
                }
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    ys.push(c);
                    bi.next();
                }
                let xs_t = xs.trim_start_matches('0');
                let ys_t = ys.trim_start_matches('0');
                let ord = xs_t.len().cmp(&ys_t.len()).then_with(|| xs_t.cmp(ys_t));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                ai.next();
                bi.next();
                let (lx, ly) = (x.to_lowercase().to_string(), y.to_lowercase().to_string());
                if lx != ly {
                    return lx.cmp(&ly);
                }
            }
        }
    }
}

/// An archive entry that is a page: an image, not a directory, not macOS junk or a
/// hidden file.
pub fn is_page(name: &str) -> bool {
    if name.ends_with('/') || name.starts_with("__MACOSX/") || name.contains("/__MACOSX/") {
        return false;
    }
    let base = name.rsplit('/').next().unwrap_or(name);
    if base.starts_with('.') || base.is_empty() {
        return false;
    }
    let ext = base.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    ext.is_some_and(|e| PAGE_EXTENSIONS.contains(&e.as_str()))
}

/// Keep the pages, in reading order (natural order of the full entry path, so
/// folders stay together and "10.jpg" follows "9.jpg").
pub fn order_pages<I: IntoIterator<Item = String>>(names: I) -> Vec<String> {
    let mut pages: Vec<String> = names.into_iter().filter(|n| is_page(n)).collect();
    pages.sort_by(|a, b| natural_cmp(a, b));
    pages.dedup();
    pages
}

fn looks_like_zip(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic))
        .map(|()| magic == *b"PK")
        .unwrap_or(false)
}

fn run(cmd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("{cmd}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("{cmd} failed")
        } else {
            err
        });
    }
    Ok(out.stdout)
}

fn have(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// 7z's `l -slt` output: one `Path = …` line per entry (the first is the archive).
fn parse_7z_listing(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen_header = false;
    for line in text.lines() {
        if line.starts_with("----------") {
            seen_header = true;
            continue;
        }
        if seen_header && let Some(p) = line.strip_prefix("Path = ") {
            out.push(p.to_string());
        }
    }
    out
}

/// Entries of the archive in reading order, plus how they will be read.
pub fn list(path: &Path) -> Result<ComicListing, String> {
    if looks_like_zip(path) {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let names: Vec<String> = (0..zip.len())
            .filter_map(|i| {
                zip.by_index_raw(i)
                    .ok()
                    .and_then(|f| f.name().ok().map(|n| n.into_owned()))
            })
            .collect();
        return Ok(ComicListing {
            pages: order_pages(names),
            source: "zip".into(),
        });
    }
    let p = path.to_string_lossy();
    if let Ok(out) = run("bsdtar", &["-tf", &p]) {
        let names = String::from_utf8_lossy(&out)
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let pages = order_pages(names);
        if !pages.is_empty() {
            return Ok(ComicListing {
                pages,
                source: "bsdtar".into(),
            });
        }
    }
    if have("7z")
        && let Ok(out) = run("7z", &["l", "-slt", "-ba", "--", &p])
    {
        let pages = order_pages(parse_7z_listing(&String::from_utf8_lossy(&out)));
        if !pages.is_empty() {
            return Ok(ComicListing {
                pages,
                source: "7z".into(),
            });
        }
    }
    if have("lsar")
        && let Ok(out) = run("lsar", &["-j", "--", &p])
    {
        let v: serde_json::Value = serde_json::from_slice(&out).map_err(|e| e.to_string())?;
        let names = v["lsarContents"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| i["XADFileName"].as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let pages = order_pages(names);
        if !pages.is_empty() {
            return Ok(ComicListing {
                pages,
                source: "unar".into(),
            });
        }
    }
    Err("No pages were found in this archive. Comics in RAR need bsdtar, 7z or unar.".into())
}

/// The bytes of one page.
pub fn page(path: &Path, name: &str, source: &str) -> Result<Vec<u8>, String> {
    if !is_page(name) {
        return Err("not a page".into());
    }
    let p = path.to_string_lossy();
    match source {
        "zip" => {
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
            let mut out = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut out).map_err(|e| e.to_string())?;
            Ok(out)
        }
        "bsdtar" => run("bsdtar", &["-xOf", &p, "--", name]),
        "7z" => run("7z", &["e", "-so", "-ba", "--", &p, name]),
        "unar" => {
            let dir = tempfile_dir()?;
            let out = run(
                "unar",
                &["-q", "-D", "-o", &dir.to_string_lossy(), "--", &p, name],
            );
            let bytes = out.and_then(|_| {
                let base = name.rsplit('/').next().unwrap_or(name);
                std::fs::read(dir.join(base)).map_err(|e| e.to_string())
            });
            let _ = std::fs::remove_dir_all(&dir);
            bytes
        }
        _ => Err("unknown source".into()),
    }
}

fn tempfile_dir() -> Result<std::path::PathBuf, String> {
    let base = std::env::temp_dir().join(format!(
        "ewe-viewer-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_counts_numbers() {
        let mut v = vec![
            "page10.jpg",
            "Page2.jpg",
            "page1.jpg",
            "page 010b.jpg",
            "page 10a.jpg",
            "cover.jpg",
        ];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            // a space sorts before digits, so "page 10a" comes before "page1"
            vec![
                "cover.jpg",
                "page 10a.jpg",
                "page 010b.jpg",
                "page1.jpg",
                "Page2.jpg",
                "page10.jpg",
            ]
        );
        assert_eq!(natural_cmp("a", "a"), Ordering::Equal);
        assert_eq!(natural_cmp("01", "1"), Ordering::Less); // same value, raw tie-break
    }

    #[test]
    fn orders_pages_and_drops_junk() {
        let names = [
            "__MACOSX/._001.jpg",
            "comic/010.jpg",
            "comic/002.JPG",
            "comic/001.png",
            "comic/",
            "comic/.hidden.jpg",
            "comic/ComicInfo.xml",
            "comic/Thumbs.db",
            "comic/002.JPG",
            "bonus/001.webp",
        ]
        .map(String::from);
        assert_eq!(
            order_pages(names),
            vec![
                "bonus/001.webp",
                "comic/001.png",
                "comic/002.JPG",
                "comic/010.jpg",
            ]
        );
    }

    #[test]
    fn parses_7z_listings() {
        let text =
            "7-Zip\n--\nPath = a.cbr\n----------\nPath = 01.jpg\nSize = 1\n\nPath = dir/02.png\n";
        assert_eq!(parse_7z_listing(text), vec!["01.jpg", "dir/02.png"]);
    }

    #[test]
    fn reads_a_cbz() {
        let dir = tempfile::tempdir().unwrap();
        let cbz = dir.path().join("book.cbz");
        {
            let f = std::fs::File::create(&cbz).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in [
                ("10.jpg", b"ten".as_slice()),
                ("2.jpg", b"two"),
                ("notes.txt", b"x"),
            ] {
                w.start_file(name, opts).unwrap();
                std::io::Write::write_all(&mut w, data).unwrap();
            }
            w.finish().unwrap();
        }
        let listing = list(&cbz).unwrap();
        assert_eq!(listing.source, "zip");
        assert_eq!(listing.pages, vec!["2.jpg", "10.jpg"]);
        assert_eq!(page(&cbz, "10.jpg", "zip").unwrap(), b"ten");
        assert!(page(&cbz, "notes.txt", "zip").is_err());
    }
}
