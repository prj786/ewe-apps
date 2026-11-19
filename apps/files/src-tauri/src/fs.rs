//! Listing folders and the small, instant changes (new folder, new file, rename,
//! link). Everything that can take a while is an operation in [`crate::ops`].

use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One row of a listing. The field names are what `@ewe/shared`'s `FsEntry` reads.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// `dir` | `file` | `link` | `other`
    pub kind: &'static str,
    /// a folder, through a symlink too
    pub dir: bool,
    pub size: u64,
    /// modified, ms since the epoch
    pub mtime: i64,
    pub hidden: bool,
    /// `broken` for a dangling link, else null
    pub target: Option<String>,
    /// the permission bits (`0o755`), for the executable glyph and Properties
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    pub writable: bool,
    pub free: Option<u64>,
}

pub fn ms(t: io::Result<std::time::SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .or_else(|e| Ok::<i64, ()>(-(e.duration().as_millis() as i64)))
                .ok()
        })
        .unwrap_or(0)
}

/// Plain words for an I/O error.
pub fn error_message(error: &io::Error) -> String {
    use io::ErrorKind::*;
    match error.kind() {
        NotFound => "It no longer exists".into(),
        PermissionDenied => "Permission denied".into(),
        AlreadyExists => "Something with that name already exists".into(),
        NotADirectory => "Not a folder".into(),
        StorageFull => "The disk is full".into(),
        ReadOnlyFilesystem => "This location is read-only".into(),
        DirectoryNotEmpty => "The folder is not empty".into(),
        _ => {
            let text = error.to_string();
            // strip the " (os error N)" tail
            match text.find(" (os error") {
                Some(i) => text[..i].to_string(),
                None => text,
            }
        }
    }
}

pub fn entry_for(path: &Path) -> Option<Entry> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let meta = std::fs::symlink_metadata(path).ok()?;
    let is_link = meta.file_type().is_symlink();
    let (mut dir, mut size, mut target, mut mode) = (
        meta.is_dir(),
        meta.len(),
        None,
        meta.permissions().mode() & 0o7777,
    );
    if is_link {
        match std::fs::metadata(path) {
            Ok(real) => {
                dir = real.is_dir();
                size = real.len();
                mode = real.permissions().mode() & 0o7777;
            }
            Err(_) => target = Some("broken".to_string()),
        }
    }
    Some(Entry {
        kind: if is_link {
            "link"
        } else if dir {
            "dir"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        },
        dir,
        size,
        mtime: ms(meta.modified()),
        hidden: name.starts_with('.'),
        target,
        mode,
        path: path.to_string_lossy().into_owned(),
        name,
    })
}

/// Free bytes for the user on the file system holding `path`.
pub fn free_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid NUL-terminated path and an out pointer of the right type
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

pub fn writable(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    match CString::new(path.as_os_str().as_bytes()) {
        // SAFETY: a valid NUL-terminated path
        Ok(c) => unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 },
        Err(_) => false,
    }
}

pub fn list(path: &Path, hidden: bool) -> io::Result<Listing> {
    let mut entries = Vec::new();
    for item in std::fs::read_dir(path)? {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name();
        if !hidden && name.to_string_lossy().starts_with('.') {
            continue;
        }
        if let Some(e) = entry_for(&item.path()) {
            entries.push(e);
        }
    }
    Ok(Listing {
        path: path.to_string_lossy().into_owned(),
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
        writable: writable(path),
        free: free_space(path),
    })
}

/// `~`, `~/x` and relative inputs become absolute paths; `.` and `..` are folded.
pub fn expand(input: &str, home: &Path) -> PathBuf {
    let p = if input == "~" {
        home.to_path_buf()
    } else if let Some(rest) = input.strip_prefix("~/") {
        home.join(rest)
    } else {
        let p = Path::new(input);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            home.join(p)
        }
    };
    normalize(&p)
}

pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir | std::path::Component::RootDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn is_inside(child: &Path, parent: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

/// `name`, else `name (1)`, `name (2)`… before the extension (`a (1).tar.gz` keeps
/// the double extension together).
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = split_ext(name);
    for n in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !exists(&candidate) {
            return candidate;
        }
    }
    dir.join(format!(
        "{stem} ({}){ext}",
        chrono::Utc::now().timestamp_millis()
    ))
}

pub fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

const MULTI_EXT: &[&str] = &[
    ".tar.gz",
    ".tar.xz",
    ".tar.zst",
    ".tar.bz2",
    ".tar.lz4",
    ".tar.lz",
    ".tar.lzma",
];

/// `report.tar.gz` → (`report`, `.tar.gz`); `.bashrc` → (`.bashrc`, ``).
pub fn split_ext(name: &str) -> (&str, &str) {
    let lower = name.to_ascii_lowercase();
    for ext in MULTI_EXT {
        if lower.ends_with(ext) && name.len() > ext.len() {
            return name.split_at(name.len() - ext.len());
        }
    }
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => name.split_at(i),
        _ => (name, ""),
    }
}

/// The base name of an archive (`photos.tar.gz` → `photos`).
pub fn archive_base(name: &str) -> String {
    let (stem, _) = split_ext(name);
    if stem.is_empty() {
        name.to_string()
    } else {
        stem.to_string()
    }
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.contains('/')
        && !name.contains('\0')
        && name != "."
        && name != ".."
}

pub fn mkdir(dir: &Path, name: &str) -> io::Result<PathBuf> {
    if !valid_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A name cannot contain /",
        ));
    }
    let path = dir.join(name);
    std::fs::create_dir(&path)?;
    Ok(path)
}

/// An empty file, or a copy of `template`.
pub fn create_file(dir: &Path, name: &str, template: Option<&Path>) -> io::Result<PathBuf> {
    if !valid_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A name cannot contain /",
        ));
    }
    let path = dir.join(name);
    if exists(&path) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Something with that name already exists",
        ));
    }
    match template {
        Some(t) => {
            std::fs::copy(t, &path)?;
        }
        None => {
            std::fs::File::create_new(&path)?;
        }
    }
    Ok(path)
}

pub fn rename(path: &Path, name: &str) -> io::Result<PathBuf> {
    if !valid_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A name cannot contain /",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Cannot rename /"))?;
    let to = parent.join(name);
    if to == path {
        return Ok(to);
    }
    // a case-only change on a case-insensitive file system is still a rename of itself
    if exists(&to) && !same_file(path, &to) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Something with that name already exists",
        ));
    }
    std::fs::rename(path, &to)?;
    Ok(to)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

/// A symlink `Link to <name>` next to the target (or in `dir`).
pub fn create_link(target: &Path, dir: &Path) -> io::Result<PathBuf> {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let link = unique_path(dir, &format!("Link to {name}"));
    std::os::unix::fs::symlink(target, &link)?;
    Ok(link)
}

/// `$XDG_TEMPLATES_DIR` (user-dirs.dirs) or `~/Templates`: the files in it.
pub fn templates(home: &Path, config_home: &Path) -> Vec<Entry> {
    let dirs = std::fs::read_to_string(config_home.join("user-dirs.dirs")).unwrap_or_default();
    let dir = crate::places::parse_user_dirs(&dirs, home)
        .remove("TEMPLATES")
        .unwrap_or_else(|| home.join("Templates"));
    let mut out: Vec<Entry> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| entry_for(&e.path()))
                .filter(|e| !e.dir && !e.hidden)
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_with_kinds_and_hidden() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        std::fs::write(dir.path().join(".secret"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("sub"), dir.path().join("to-sub")).unwrap();
        std::os::unix::fs::symlink("/nowhere/at/all", dir.path().join("dangling")).unwrap();
        let shown = list(dir.path(), false).unwrap();
        let names: Vec<&str> = shown.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names.len(), 4);
        assert!(!names.contains(&".secret"));
        let link = shown.entries.iter().find(|e| e.name == "to-sub").unwrap();
        assert!(link.dir && link.kind == "link" && link.target.is_none());
        let broken = shown.entries.iter().find(|e| e.name == "dangling").unwrap();
        assert_eq!(broken.target.as_deref(), Some("broken"));
        assert_eq!(list(dir.path(), true).unwrap().entries.len(), 5);
        assert!(shown.writable);
        assert!(shown.free.is_some());
    }

    #[test]
    fn expands_and_normalizes() {
        let home = Path::new("/home/me");
        assert_eq!(expand("~", home), PathBuf::from("/home/me"));
        assert_eq!(expand("~/a/../b", home), PathBuf::from("/home/me/b"));
        assert_eq!(expand("/x//y/./z/", home), PathBuf::from("/x/y/z"));
        assert_eq!(expand("rel", home), PathBuf::from("/home/me/rel"));
        assert_eq!(expand("/..", home), PathBuf::from("/"));
    }

    #[test]
    fn unique_names_keep_extensions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.tar.gz"), "").unwrap();
        std::fs::write(dir.path().join("a (1).tar.gz"), "").unwrap();
        assert_eq!(
            unique_path(dir.path(), "a.tar.gz"),
            dir.path().join("a (2).tar.gz")
        );
        assert_eq!(unique_path(dir.path(), "new"), dir.path().join("new"));
        std::fs::write(dir.path().join(".bashrc"), "").unwrap();
        assert_eq!(
            unique_path(dir.path(), ".bashrc"),
            dir.path().join(".bashrc (1)")
        );
        assert_eq!(archive_base("photos.tar.gz"), "photos");
        assert_eq!(archive_base("x.zip"), "x");
        assert_eq!(archive_base("noext"), "noext");
    }

    #[test]
    fn creates_renames_links() {
        let dir = tempfile::tempdir().unwrap();
        let d = mkdir(dir.path(), "New folder").unwrap();
        assert!(d.is_dir());
        assert!(mkdir(dir.path(), "a/b").is_err());
        let f = create_file(dir.path(), "note.txt", None).unwrap();
        assert_eq!(std::fs::read(&f).unwrap().len(), 0);
        assert!(create_file(dir.path(), "note.txt", None).is_err());
        let t = dir.path().join("tpl.md");
        std::fs::write(&t, "# hello").unwrap();
        let g = create_file(dir.path(), "from-tpl.md", Some(&t)).unwrap();
        assert_eq!(std::fs::read_to_string(g).unwrap(), "# hello");
        let r = rename(&f, "renamed.txt").unwrap();
        assert!(r.exists() && !f.exists());
        assert!(rename(&r, "tpl.md").is_err());
        assert_eq!(rename(&r, "renamed.txt").unwrap(), r);
        let l = create_link(&r, dir.path()).unwrap();
        assert_eq!(l.file_name().unwrap(), "Link to renamed.txt");
        assert_eq!(std::fs::read_link(&l).unwrap(), r);
        let l2 = create_link(&r, dir.path()).unwrap();
        assert_eq!(l2.file_name().unwrap(), "Link to renamed (1).txt");
    }

    #[test]
    fn error_words() {
        let e = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(error_message(&e), "Permission denied");
        let e = io::Error::from_raw_os_error(libc::ENOENT);
        assert_eq!(error_message(&e), "It no longer exists");
        let e = io::Error::from_raw_os_error(libc::EXDEV);
        assert!(!error_message(&e).contains("os error"));
    }
}
