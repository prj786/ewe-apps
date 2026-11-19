//! Properties: the full stat, owner and group names, permission changes, and the
//! live size of a folder (streamed as `size-progress`).

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;

use crate::ops::Emit;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub path: String,
    pub name: String,
    pub dir: bool,
    pub link: Option<String>,
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub owner: String,
    pub group: String,
    pub accessed: i64,
    pub modified: i64,
    pub changed: i64,
    pub links: u64,
    pub inode: u64,
    pub device: u64,
    /// the mount point this file lives on
    pub mount: String,
    pub free: Option<u64>,
    pub total: Option<u64>,
    pub mine: bool,
}

fn name_of_uid(uid: u32) -> String {
    let mut buf = vec![0u8; 1024];
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: valid out pointers; the buffer is sized by us
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pw,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        )
    };
    if rc == 0 && !result.is_null() && !pw.pw_name.is_null() {
        // SAFETY: pw_name points into our buffer and is NUL-terminated
        return unsafe { std::ffi::CStr::from_ptr(pw.pw_name) }
            .to_string_lossy()
            .into_owned();
    }
    uid.to_string()
}

fn name_of_gid(gid: u32) -> String {
    let mut buf = vec![0u8; 1024];
    let mut gr: libc::group = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::group = std::ptr::null_mut();
    // SAFETY: as above
    let rc = unsafe {
        libc::getgrgid_r(
            gid,
            &mut gr,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        )
    };
    if rc == 0 && !result.is_null() && !gr.gr_name.is_null() {
        // SAFETY: gr_name points into our buffer and is NUL-terminated
        return unsafe { std::ffi::CStr::from_ptr(gr.gr_name) }
            .to_string_lossy()
            .into_owned();
    }
    gid.to_string()
}

fn mount_of(path: &Path) -> String {
    let dev = std::fs::metadata(path).map(|m| m.dev()).ok();
    let mut best = PathBuf::from("/");
    for m in crate::trash::mount_points() {
        if path.starts_with(&m)
            && m.as_os_str().len() > best.as_os_str().len()
            && std::fs::metadata(&m)
                .map(|x| Some(x.dev()) == dev)
                .unwrap_or(false)
        {
            best = m;
        }
    }
    best.to_string_lossy().into_owned()
}

fn total_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid NUL-terminated path and an out pointer of the right type
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_blocks as u64 * st.f_frsize as u64)
}

pub fn stat(path: &Path) -> std::io::Result<Stat> {
    let lmeta = std::fs::symlink_metadata(path)?;
    let meta = std::fs::metadata(path).unwrap_or_else(|_| lmeta.clone());
    let link = if lmeta.file_type().is_symlink() {
        std::fs::read_link(path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned())
    } else {
        None
    };
    // SAFETY: geteuid has no preconditions
    let me = unsafe { libc::geteuid() };
    Ok(Stat {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into()),
        dir: meta.is_dir(),
        link,
        size: meta.len(),
        mode: meta.permissions().mode() & 0o7777,
        uid: meta.uid(),
        gid: meta.gid(),
        owner: name_of_uid(meta.uid()),
        group: name_of_gid(meta.gid()),
        accessed: crate::fs::ms(meta.accessed()),
        modified: crate::fs::ms(meta.modified()),
        changed: meta.ctime() * 1000 + meta.ctime_nsec() / 1_000_000,
        links: meta.nlink(),
        inode: meta.ino(),
        device: meta.dev(),
        mount: mount_of(path),
        free: crate::fs::free_space(path),
        total: total_space(path),
        mine: meta.uid() == me,
    })
}

pub fn chmod(path: &Path, mode: u32) -> std::io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777))
}

/// `rwxr-xr--` for a mode.
pub fn mode_text(mode: u32) -> String {
    let bits = ["x", "w", "r"];
    let mut out = String::new();
    for shift in (0..9).rev() {
        out.push_str(if mode & (1 << shift) != 0 {
            bits[shift % 3]
        } else {
            "-"
        });
    }
    out
}

/// Bytes, files and folders under `paths`, streamed every ~100 ms as
/// `size-progress {id, bytes, files, dirs, done}`; `stop` ends it early.
pub fn folder_size(id: u64, paths: Vec<PathBuf>, emit: Emit, stop: Arc<AtomicBool>) {
    let (bytes, files, dirs) = (AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0));
    let mut last = std::time::Instant::now();
    let send = |done: bool| {
        emit(
            "size-progress",
            serde_json::json!({
                "id": id,
                "bytes": bytes.load(Ordering::Relaxed),
                "files": files.load(Ordering::Relaxed),
                "dirs": dirs.load(Ordering::Relaxed),
                "done": done,
            }),
        );
    };
    for p in &paths {
        for e in walkdir::WalkDir::new(p).follow_links(false).min_depth(0) {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let Ok(e) = e else { continue };
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                if e.depth() > 0 {
                    dirs.fetch_add(1, Ordering::Relaxed);
                }
            } else {
                files.fetch_add(1, Ordering::Relaxed);
                // what the disk holds, not the apparent size, like `du`
                bytes.fetch_add(m.blocks() * 512, Ordering::Relaxed);
            }
            if last.elapsed() > std::time::Duration::from_millis(100) {
                send(false);
                last = std::time::Instant::now();
            }
        }
    }
    send(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_and_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "hello").unwrap();
        chmod(&f, 0o640).unwrap();
        let s = stat(&f).unwrap();
        assert_eq!(s.mode, 0o640);
        assert_eq!(s.size, 5);
        assert!(s.mine);
        assert!(!s.owner.is_empty() && !s.group.is_empty());
        assert!(s.mount.starts_with('/'));
        assert!(s.total.unwrap() >= s.free.unwrap());
        assert_eq!(mode_text(0o754), "rwxr-xr--");
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b"), vec![1u8; 10_000]).unwrap();
        let got = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = got.clone();
        folder_size(
            7,
            vec![dir.path().to_path_buf()],
            Arc::new(move |_, v| sink.lock().unwrap().push(v)),
            Arc::new(AtomicBool::new(false)),
        );
        let last = got.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last["done"], true);
        assert_eq!(last["files"], 2);
        assert_eq!(last["dirs"], 1);
        assert!(last["bytes"].as_u64().unwrap() >= 10_000);
    }
}
