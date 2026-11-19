//! Archives through `bsdtar` (list, extract, compress zip / tar.gz / tar.zst), `7z`
//! (compress 7z) and `lsar` / `unar` (RAR and whatever bsdtar cannot read). No shell.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

pub const MAX_LISTED: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ArchiveEntry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub path: String,
    pub count: usize,
    pub size: u64,
    pub entries: Vec<ArchiveEntry>,
    pub truncated: bool,
    pub root: Option<String>,
}

fn err(text: impl Into<String>) -> io::Error {
    io::Error::other(text.into())
}

fn has(tool: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(tool).is_file()))
        .unwrap_or(false)
}

fn run(tool: &str, args: &[&str], cwd: Option<&Path>) -> io::Result<String> {
    let mut cmd = Command::new(tool);
    cmd.args(args).stdin(std::process::Stdio::null());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            err(format!("{tool} is not installed"))
        } else {
            e
        }
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let last = stderr
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("failed")
            .trim()
            .to_string();
        Err(err(last
            .strip_prefix("bsdtar: ")
            .unwrap_or(&last)
            .to_string()))
    }
}

/// `bsdtar -tvf` rows: `drwxr-xr-x  0 me me  0 Nov 19 10:30 dir/` …
pub fn parse_bsdtar(text: &str) -> Vec<ArchiveEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(mode) = parts.next() else { continue };
        // mode, links, owner, group, size, month, day, time-or-year, name…
        let fields: Vec<&str> = parts.collect();
        if fields.len() < 8 {
            continue;
        }
        let Ok(size) = fields[3].parse::<u64>() else {
            continue;
        };
        // the name is whatever follows the 8th column in the original line
        let head = format!(
            "{mode} {} {} {} {} {} {} {} ",
            fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]
        );
        let name = match find_after_columns(line, 8) {
            Some(n) => n,
            None => continue,
        };
        let _ = head;
        let name = name
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if name.is_empty() || name == "." {
            continue;
        }
        let name = match name.split_once(" -> ") {
            Some((n, _)) if mode.starts_with('l') => n.to_string(),
            _ => name,
        };
        out.push(ArchiveEntry {
            name,
            dir: mode.starts_with('d'),
            size,
        });
    }
    out
}

/// The text after `n` whitespace-separated columns (keeps spaces inside the name).
fn find_after_columns(line: &str, n: usize) -> Option<&str> {
    let mut rest = line;
    for _ in 0..n {
        rest = rest.trim_start();
        let end = rest.find(char::is_whitespace)?;
        rest = &rest[end..];
    }
    let rest = rest.trim_start();
    (!rest.is_empty()).then_some(rest)
}

/// `lsar -j` (The Unarchiver) JSON.
pub fn parse_lsar(text: &str) -> Option<Vec<ArchiveEntry>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let items = v.get("lsarContents")?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|i| {
                let name = i
                    .get("XADFileName")?
                    .as_str()?
                    .trim_end_matches('/')
                    .to_string();
                if name.is_empty() {
                    return None;
                }
                Some(ArchiveEntry {
                    name,
                    dir: i.get("XADIsDirectory").and_then(|d| d.as_u64()) == Some(1),
                    size: i.get("XADFileSize").and_then(|s| s.as_u64()).unwrap_or(0),
                })
            })
            .collect(),
    )
}

/// The one top-level folder every entry sits in, when there is one.
pub fn single_root(entries: &[ArchiveEntry]) -> Option<String> {
    let mut root: Option<&str> = None;
    for e in entries {
        let top = e.name.split('/').next().unwrap_or("");
        match root {
            None => root = Some(top),
            Some(r) if r != top => return None,
            _ => {}
        }
    }
    let top = root?;
    entries
        .iter()
        .any(|e| e.name.starts_with(&format!("{top}/")) || (e.dir && e.name == top))
        .then(|| top.to_string())
}

fn is_rar(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("rar"))
        .unwrap_or(false)
}

fn entries_of(path: &Path) -> io::Result<Vec<ArchiveEntry>> {
    let p = path.to_string_lossy();
    let via_bsdtar = if is_rar(path) && has("lsar") {
        None
    } else {
        Some(run("bsdtar", &["-tvf", &p], None).map(|t| parse_bsdtar(&t)))
    };
    match via_bsdtar {
        Some(Ok(entries)) => Ok(entries),
        other => {
            if has("lsar") {
                let json = run("lsar", &["-j", &p], None)?;
                parse_lsar(&json).ok_or_else(|| err("Could not read the archive"))
            } else {
                match other {
                    Some(Err(e)) => Err(e),
                    _ => Err(err("unar is not installed")),
                }
            }
        }
    }
}

pub fn list(path: &Path) -> io::Result<ArchiveListing> {
    let entries = entries_of(path)?;
    Ok(ArchiveListing {
        path: path.to_string_lossy().into_owned(),
        count: entries.iter().filter(|e| !e.dir).count(),
        size: entries.iter().map(|e| e.size).sum(),
        truncated: entries.len() > MAX_LISTED,
        root: single_root(&entries),
        entries: entries.into_iter().take(MAX_LISTED).collect(),
    })
}

fn extract_into(path: &Path, dest: &Path) -> io::Result<()> {
    let p = path.to_string_lossy();
    let d = dest.to_string_lossy();
    if !(is_rar(path) && has("unar")) {
        match run("bsdtar", &["-xf", &p, "-C", &d], None) {
            Ok(_) => return Ok(()),
            Err(e) if !has("unar") => return Err(e),
            Err(_) => {}
        }
    }
    run("unar", &["-q", "-f", "-D", "-o", &d, &p], None).map(|_| ())
}

/// Extract next to the archive: into `<dir>/<root>` when the archive has one top
/// folder that does not exist yet, else into a new `<dir>/<base>` folder.
pub fn extract_here(path: &Path) -> io::Result<PathBuf> {
    let dir = path
        .parent()
        .ok_or_else(|| err("The archive has no folder"))?;
    extract_to(path, dir)
}

/// Extract into `dir` (same rule as [`extract_here`] for the folder name).
pub fn extract_to(path: &Path, dir: &Path) -> io::Result<PathBuf> {
    let entries = entries_of(path)?;
    if let Some(root) = single_root(&entries) {
        if !crate::fs::exists(&dir.join(&root)) {
            extract_into(path, dir)?;
            return Ok(dir.join(root));
        }
        // the folder is taken: unpack aside, then move the root in under a free name
        let tmp = crate::fs::unique_path(dir, ".ewe-extract");
        std::fs::create_dir(&tmp)?;
        let result = extract_into(path, &tmp).and_then(|()| {
            let dest = crate::fs::unique_path(dir, &root);
            std::fs::rename(tmp.join(&root), &dest)?;
            Ok(dest)
        });
        let _ = std::fs::remove_dir_all(&tmp);
        return result;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".into());
    let dest = crate::fs::unique_path(dir, &crate::fs::archive_base(&name));
    std::fs::create_dir(&dest)?;
    if let Err(e) = extract_into(path, &dest) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(dest)
}

pub fn extension_of(format: &str) -> Option<&'static str> {
    Some(match format {
        "zip" => ".zip",
        "tar.gz" => ".tar.gz",
        "tar.zst" => ".tar.zst",
        "tar.xz" => ".tar.xz",
        "7z" => ".7z",
        _ => return None,
    })
}

/// Compress `paths` (all in one folder) into `<dir>/<name><ext>`; `name` defaults
/// to the single item's name or `Archive`.
pub fn compress(paths: &[PathBuf], format: &str, name: Option<&str>) -> io::Result<PathBuf> {
    let first = paths.first().ok_or_else(|| err("Nothing to compress"))?;
    let dir = first.parent().ok_or_else(|| err("Cannot compress /"))?;
    if paths.iter().any(|p| p.parent() != Some(dir)) {
        return Err(err("Items must be in one folder"));
    }
    let ext = extension_of(format).ok_or_else(|| err("Unknown archive type"))?;
    let base = match name {
        Some(n) if crate::fs::valid_name(n) => n.to_string(),
        _ if paths.len() == 1 => first
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Archive".into()),
        _ => "Archive".into(),
    };
    let base = if base.to_ascii_lowercase().ends_with(ext) {
        base[..base.len() - ext.len()].to_string()
    } else {
        base
    };
    let out = crate::fs::unique_path(dir, &format!("{base}{ext}"));
    let names: Vec<String> = paths
        .iter()
        .filter_map(|p| p.file_name())
        .map(|n| format!("./{}", n.to_string_lossy()))
        .collect();
    let out_s = out.to_string_lossy().into_owned();
    let result = if format == "7z" {
        let mut args = vec!["a", "-y", "-bd", "-bso0", out_s.as_str()];
        args.extend(names.iter().map(String::as_str));
        run(if has("7z") { "7z" } else { "7za" }, &args, Some(dir))
    } else {
        let mut args = vec!["-a", "-cf", out_s.as_str()];
        args.extend(names.iter().map(String::as_str));
        run("bsdtar", &args, Some(dir))
    };
    if let Err(e) = result {
        let _ = std::fs::remove_file(&out);
        return Err(e);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bsdtar_rows_with_spaces_and_links() {
        let text = "drwxr-xr-x  0 me   me      0 Nov 19 10:30 photos/\n-rw-r--r--  0 me   me   1234 Nov 19 10:30 photos/my pic.jpg\nlrwxr-xr-x  0 me   me      0 Jan  1  2024 photos/link -> my pic.jpg\n-rw-r--r--  0 me   me     12 Nov 19 10:30 ./readme.txt\n";
        let rows = parse_bsdtar(text);
        assert_eq!(rows.len(), 4);
        assert_eq!(
            rows[0],
            ArchiveEntry {
                name: "photos".into(),
                dir: true,
                size: 0
            }
        );
        assert_eq!(rows[1].name, "photos/my pic.jpg");
        assert_eq!(rows[1].size, 1234);
        assert_eq!(rows[2].name, "photos/link");
        assert_eq!(rows[3].name, "readme.txt");
        assert_eq!(single_root(&rows), None);
        assert_eq!(single_root(&rows[..3]), Some("photos".into()));
        assert_eq!(single_root(&[]), None);
    }

    #[test]
    fn parses_lsar_json() {
        let rows = parse_lsar(
            r#"{"lsarFormatName":"RAR","lsarContents":[{"XADFileName":"a/","XADIsDirectory":1},{"XADFileName":"a/b.txt","XADFileSize":5}]}"#,
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].dir);
        assert_eq!(rows[1].size, 5);
        assert_eq!(single_root(&rows), Some("a".into()));
    }

    #[test]
    fn round_trips_through_bsdtar_and_7z() {
        if !has("bsdtar") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("photos");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("a b.txt"), "hello").unwrap();
        std::fs::write(src.join("c.txt"), "world!").unwrap();
        for format in ["zip", "tar.gz", "tar.zst", "7z"] {
            if format == "7z" && !(has("7z") || has("7za")) {
                continue;
            }
            let out = compress(std::slice::from_ref(&src), format, None).unwrap();
            assert_eq!(
                out.file_name().unwrap().to_string_lossy(),
                format!("photos.{format}")
            );
            let listing = list(&out).unwrap();
            assert_eq!(listing.count, 2, "{format}: {:?}", listing.entries);
            assert_eq!(listing.size, 11);
            assert_eq!(listing.root.as_deref(), Some("photos"));
            // the folder exists → a new "photos (1)" next to it
            let dest = extract_here(&out).unwrap();
            assert_eq!(dest, dir.path().join("photos (1)"));
            assert_eq!(
                std::fs::read_to_string(dest.join("a b.txt")).unwrap(),
                "hello"
            );
            std::fs::remove_dir_all(&dest).unwrap();
            // into an empty folder → the archive's own top folder
            let other = dir.path().join(format!("out-{format}"));
            std::fs::create_dir(&other).unwrap();
            let dest = extract_to(&out, &other).unwrap();
            assert_eq!(dest, other.join("photos"));
            assert_eq!(
                std::fs::read_to_string(dest.join("c.txt")).unwrap(),
                "world!"
            );
        }
        // two items → Archive.zip, no single root → "Archive" folder on extract
        let loose = dir.path().join("loose.txt");
        std::fs::write(&loose, "x").unwrap();
        let out = compress(&[src.clone(), loose], "zip", Some("bundle")).unwrap();
        assert!(out.ends_with("bundle.zip"));
        let l = list(&out).unwrap();
        assert_eq!(l.root, None);
        let dest = extract_here(&out).unwrap();
        assert_eq!(dest, dir.path().join("bundle"));
        assert!(dest.join("loose.txt").is_file());
        assert!(list(&dir.path().join("missing.zip")).is_err());
    }
}
