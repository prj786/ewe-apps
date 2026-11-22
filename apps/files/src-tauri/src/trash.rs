//! The freedesktop Trash (spec 1.0): the home trash at `$XDG_DATA_HOME/Trash` and,
//! for files on other file systems, `<top dir>/.Trash/<uid>` or `<top dir>/.Trash-<uid>`,
//! so a USB drive's files stay on the drive. `files/<name>` + `info/<name>.trashinfo`
//! with `Path=` (URL-escaped; relative to the top dir on other drives) and
//! `DeletionDate=` (local time, ISO 8601).

use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashedItem {
    /// the file inside `files/`
    pub path: String,
    pub info: String,
    pub original: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub name: String,
    /// where it sits now (`…/Trash/files/<name>`)
    pub path: String,
    pub original: String,
    /// ms since the epoch
    pub deleted: i64,
    pub size: u64,
    pub dir: bool,
    pub mtime: i64,
    pub mode: u32,
    /// a trashed eep card: the app (restoring it brings the app back)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<ewe_app_core::eep::AppCard>,
}

/// Everything that decides where a trash lives: injectable for tests.
#[derive(Debug, Clone)]
pub struct TrashEnv {
    pub home_trash: PathBuf,
    pub uid: u32,
    /// mount points other than `/` (from /proc/mounts); empty in tests
    pub mounts: Vec<PathBuf>,
}

impl TrashEnv {
    pub fn system(data_home: &Path) -> TrashEnv {
        TrashEnv {
            home_trash: data_home.join("Trash"),
            // SAFETY: getuid has no preconditions
            uid: unsafe { libc::getuid() },
            mounts: mount_points(),
        }
    }
}

pub fn mount_points() -> Vec<PathBuf> {
    let text = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    parse_mounts(&text)
}

pub fn parse_mounts(text: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split(' ');
        let (Some(_dev), Some(point)) = (parts.next(), parts.next()) else {
            continue;
        };
        let point = point.replace("\\040", " ").replace("\\011", "\t");
        if point != "/" {
            out.push(PathBuf::from(point));
        }
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
    out
}

fn dev_of(p: &Path) -> Option<u64> {
    std::fs::symlink_metadata(p).ok().map(|m| m.dev())
}

/// The top directory of the file system holding `path` (the longest mount point
/// that is a prefix and sits on the same device), or none for the root file system.
fn top_dir(env: &TrashEnv, path: &Path) -> Option<PathBuf> {
    let dev = dev_of(path)?;
    env.mounts
        .iter()
        .find(|m| path.starts_with(m) && dev_of(m) == Some(dev))
        .cloned()
}

/// Which trash takes `path`: `(trash dir, top dir)`; `top dir` None means the home
/// trash, where `Path=` is absolute.
pub fn trash_dir_for(env: &TrashEnv, path: &Path) -> (PathBuf, Option<PathBuf>) {
    let home_dev = dev_of(&env.home_trash).or_else(|| env.home_trash.parent().and_then(dev_of));
    if dev_of(path).is_some() && dev_of(path) == home_dev {
        return (env.home_trash.clone(), None);
    }
    let Some(top) = top_dir(env, path) else {
        return (env.home_trash.clone(), None);
    };
    // (1) $top/.Trash: must exist, be a sticky directory and not a symlink
    let shared = top.join(".Trash");
    if let Ok(m) = std::fs::symlink_metadata(&shared)
        && m.is_dir()
        && m.mode() & 0o1000 != 0
    {
        let mine = shared.join(env.uid.to_string());
        if ensure_dirs(&mine).is_ok() {
            return (mine, Some(top));
        }
    }
    // (2) $top/.Trash-$uid
    let own = top.join(format!(".Trash-{}", env.uid));
    if ensure_dirs(&own).is_ok() {
        return (own, Some(top));
    }
    (env.home_trash.clone(), None)
}

fn ensure_dirs(trash: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    for sub in ["files", "info"] {
        let p = trash.join(sub);
        if !p.is_dir() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&p)?;
        }
    }
    Ok(())
}

fn escape(path: &str) -> String {
    use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
    const SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'%')
        .add(b'#')
        .add(b'?')
        .add(b'"')
        .add(b'<')
        .add(b'>')
        .add(b'[')
        .add(b']')
        .add(b'\\')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');
    utf8_percent_encode(path, SET).to_string()
}

fn unescape(text: &str) -> String {
    percent_encoding::percent_decode_str(text)
        .decode_utf8_lossy()
        .into_owned()
}

/// Move `path` into the trash. `now` is local time.
pub fn trash(env: &TrashEnv, path: &Path, now: chrono::NaiveDateTime) -> io::Result<TrashedItem> {
    let (trash, top) = trash_dir_for(env, path);
    ensure_dirs(&trash)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Cannot trash /"))?
        .to_string_lossy()
        .into_owned();
    let original = match &top {
        Some(top) => path
            .strip_prefix(top)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned()),
        None => path.to_string_lossy().into_owned(),
    };
    let body = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        escape(&original),
        now.format("%Y-%m-%dT%H:%M:%S")
    );
    // the .trashinfo is created exclusively: whoever gets the name owns it
    let mut n = 0;
    let (info, files) = loop {
        let candidate = if n == 0 {
            name.clone()
        } else {
            let (stem, ext) = crate::fs::split_ext(&name);
            format!("{stem}.{}{ext}", n + 1)
        };
        let info = trash.join("info").join(format!("{candidate}.trashinfo"));
        match std::fs::File::create_new(&info) {
            Ok(mut f) => {
                io::Write::write_all(&mut f, body.as_bytes())?;
                break (info, trash.join("files").join(candidate));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && n < 10_000 => n += 1,
            Err(e) => return Err(e),
        }
    };
    if let Err(e) = std::fs::rename(path, &files) {
        let _ = std::fs::remove_file(&info);
        return Err(e);
    }
    Ok(TrashedItem {
        path: files.to_string_lossy().into_owned(),
        info: info.to_string_lossy().into_owned(),
        original: path.to_string_lossy().into_owned(),
    })
}

/// Every trash directory that exists: the home one and the ones on mounted drives.
pub fn trash_dirs(env: &TrashEnv) -> Vec<(PathBuf, Option<PathBuf>)> {
    let mut out = vec![(env.home_trash.clone(), None)];
    for top in &env.mounts {
        for t in [
            top.join(".Trash").join(env.uid.to_string()),
            top.join(format!(".Trash-{}", env.uid)),
        ] {
            if t.join("files").is_dir() {
                out.push((t, Some(top.clone())));
            }
        }
    }
    out
}

fn parse_info(text: &str, top: Option<&Path>) -> Option<(String, i64)> {
    let mut path = None;
    let mut date = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Path=") {
            path.get_or_insert_with(|| unescape(v.trim()));
        } else if let Some(v) = line.strip_prefix("DeletionDate=") {
            date = chrono::NaiveDateTime::parse_from_str(v.trim(), "%Y-%m-%dT%H:%M:%S").ok();
        }
    }
    let p = path?;
    let abs = match top {
        Some(top) if !p.starts_with('/') => top.join(&p).to_string_lossy().into_owned(),
        _ => p,
    };
    let ms = date
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    Some((abs, ms))
}

pub fn list(env: &TrashEnv) -> Vec<TrashEntry> {
    let mut out = Vec::new();
    for (trash, top) in trash_dirs(env) {
        let Ok(rd) = std::fs::read_dir(trash.join("files")) else {
            continue;
        };
        for item in rd.filter_map(|e| e.ok()) {
            let name = item.file_name().to_string_lossy().into_owned();
            let info_path = trash.join("info").join(format!("{name}.trashinfo"));
            let (original, deleted) = std::fs::read_to_string(&info_path)
                .ok()
                .and_then(|t| parse_info(&t, top.as_deref()))
                .unwrap_or_else(|| (String::new(), 0));
            let Some(e) = crate::fs::entry_for(&item.path()) else {
                continue;
            };
            out.push(TrashEntry {
                name,
                path: e.path,
                original,
                deleted,
                size: e.size,
                dir: e.dir,
                mtime: e.mtime,
                mode: e.mode,
                app: e.app,
            });
        }
    }
    out
}

fn info_for(trashed: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    let files = trashed.parent()?;
    if files.file_name()? != "files" {
        return None;
    }
    let trash = files.parent()?;
    let name = trashed.file_name()?.to_string_lossy().into_owned();
    Some((
        trash.join("info").join(format!("{name}.trashinfo")),
        top_of(trash),
    ))
}

/// `/media/x/.Trash-1000` → `/media/x`; the home trash → None.
fn top_of(trash: &Path) -> Option<PathBuf> {
    let name = trash.file_name()?.to_string_lossy().into_owned();
    if name.starts_with(".Trash-") {
        return trash.parent().map(Path::to_path_buf);
    }
    let parent = trash.parent()?;
    if parent.file_name()? == ".Trash" {
        return parent.parent().map(Path::to_path_buf);
    }
    None
}

/// Put a trashed file back where it came from (a unique name when the place is taken).
pub fn restore(trashed: &Path) -> io::Result<PathBuf> {
    let (info, top) = info_for(trashed)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Not in the Trash"))?;
    let text = std::fs::read_to_string(&info)?;
    let (original, _) = parse_info(&text, top.as_deref())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No record of where it was"))?;
    let original = PathBuf::from(original);
    let parent = original
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No record of where it was"))?;
    std::fs::create_dir_all(parent)?;
    let name = original
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dest = crate::fs::unique_path(parent, &name);
    std::fs::rename(trashed, &dest)?;
    let _ = std::fs::remove_file(info);
    Ok(dest)
}

pub fn delete_forever(trashed: &Path) -> io::Result<()> {
    let info = info_for(trashed).map(|(i, _)| i);
    remove_any(trashed)?;
    if let Some(i) = info {
        let _ = std::fs::remove_file(i);
    }
    Ok(())
}

pub fn remove_any(path: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

pub fn empty(env: &TrashEnv) -> io::Result<usize> {
    let mut n = 0;
    for e in list(env) {
        delete_forever(Path::new(&e.path))?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(root: &Path) -> TrashEnv {
        TrashEnv {
            home_trash: root.join("share").join("Trash"),
            uid: 1000,
            mounts: vec![],
        }
    }

    #[test]
    fn trashes_lists_restores_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        let f = dir.path().join("my file #1.txt");
        std::fs::write(&f, "hello").unwrap();
        let now = chrono::NaiveDate::from_ymd_opt(2026, 11, 19)
            .unwrap()
            .and_hms_opt(10, 30, 0)
            .unwrap();
        let t = trash(&env, &f, now).unwrap();
        assert!(!f.exists());
        assert!(Path::new(&t.path).exists());
        let info = std::fs::read_to_string(&t.info).unwrap();
        assert!(info.contains("[Trash Info]\nPath="));
        assert!(info.contains("my%20file%20%231.txt"));
        assert!(info.contains("DeletionDate=2026-11-19T10:30:00"));

        // a second file with the same name gets ".2"
        std::fs::write(&f, "again").unwrap();
        let t2 = trash(&env, &f, now).unwrap();
        assert!(t2.path.ends_with("my file #1.2.txt"));

        let listed = list(&env);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|e| e.original == f.to_string_lossy()));
        assert!(listed.iter().all(|e| e.deleted > 0));

        let back = restore(Path::new(&t.path)).unwrap();
        assert_eq!(back, f);
        assert_eq!(std::fs::read_to_string(&back).unwrap(), "hello");
        assert!(!Path::new(&t.info).exists());
        // restoring the second lands next to the first under a unique name
        let back2 = restore(Path::new(&t2.path)).unwrap();
        assert_eq!(back2, dir.path().join("my file #1 (1).txt"));

        let d = dir.path().join("folder");
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join("inner"), "x").unwrap();
        let td = trash(&env, &d, now).unwrap();
        assert_eq!(list(&env).len(), 1);
        delete_forever(Path::new(&td.path)).unwrap();
        assert!(list(&env).is_empty());
        assert!(!Path::new(&td.info).exists());

        std::fs::write(&f, "z").unwrap();
        trash(&env, &f, now).unwrap();
        assert_eq!(empty(&env).unwrap(), 1);
        assert!(list(&env).is_empty());
    }

    #[test]
    fn other_drive_uses_a_top_dir_trash_with_relative_paths() {
        // pretend the temp dir is its own mount point on another device by
        // making the home trash live on a path whose device we cannot match
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().join("usb");
        std::fs::create_dir_all(top.join("docs")).unwrap();
        let f = top.join("docs").join("a.txt");
        std::fs::write(&f, "1").unwrap();
        let env = TrashEnv {
            home_trash: PathBuf::from("/proc/self/nonexistent/Trash"),
            uid: 1000,
            mounts: vec![top.clone()],
        };
        // dev_of(home_trash) is None → not the home device → top dir wins
        let (t, tp) = trash_dir_for(&env, &f);
        assert_eq!(t, top.join(".Trash-1000"));
        assert_eq!(tp, Some(top.clone()));
        let now = chrono::Local::now().naive_local();
        let item = trash(&env, &f, now).unwrap();
        let info = std::fs::read_to_string(&item.info).unwrap();
        assert!(info.contains("Path=docs/a.txt"), "{info}");
        let listed = list(&env);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].original, f.to_string_lossy());
        assert_eq!(restore(Path::new(&item.path)).unwrap(), f);
    }

    #[test]
    fn parses_mounts() {
        let m = parse_mounts(
            "dev / ext4 rw 0 0\n/dev/sdb1 /run/media/me/My\\040USB vfat rw 0 0\nproc /proc proc rw 0 0\n",
        );
        assert_eq!(m[0], PathBuf::from("/run/media/me/My USB"));
        assert!(m.contains(&PathBuf::from("/proc")));
        assert!(!m.contains(&PathBuf::from("/")));
    }
}
