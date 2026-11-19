//! Folder watches: one per pane (`<window>/<pane>`), debounced 200 ms, emitting
//! `fs-changed {key, path}`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use crate::ops::Emit;

const DEBOUNCE: Duration = Duration::from_millis(200);

struct Watch {
    path: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
pub struct Watches {
    inner: Mutex<HashMap<String, Watch>>,
}

impl Watches {
    /// Watch `path` for `key` (replacing that key's old watch); `None` stops it.
    pub fn set(&self, key: &str, path: Option<&Path>, emit: Emit) {
        let mut map = self.inner.lock().unwrap();
        if let Some(current) = map.get(key)
            && Some(current.path.as_path()) == path
        {
            return;
        }
        map.remove(key);
        let Some(path) = path else { return };
        let key_owned = key.to_string();
        let path_owned = path.to_path_buf();
        let pending: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let pending2 = pending.clone();
        let emit_path = path_owned.clone();
        let handler = move |res: notify::Result<notify::Event>| {
            // notify's inotify mask includes OPEN: our own read_dir would be a "change"
            // (and a reload loop); only real changes count
            match res {
                Ok(e) if !matches!(e.kind, notify::EventKind::Access(_)) => {}
                _ => return,
            }
            let mut p = pending2.lock().unwrap();
            let first = p.is_none();
            *p = Some(Instant::now());
            drop(p);
            if !first {
                return;
            }
            let pending = pending2.clone();
            let emit = emit.clone();
            let key = key_owned.clone();
            let path = emit_path.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(DEBOUNCE);
                    let mut p = pending.lock().unwrap();
                    match *p {
                        Some(last) if last.elapsed() < DEBOUNCE => continue,
                        _ => {
                            *p = None;
                            break;
                        }
                    }
                }
                emit(
                    "fs-changed",
                    serde_json::json!({ "key": key, "path": path.to_string_lossy() }),
                );
            });
        };
        let Ok(mut watcher) = notify::recommended_watcher(handler) else {
            return;
        };
        if watcher.watch(path, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        map.insert(
            key.to_string(),
            Watch {
                path: path_owned,
                _watcher: watcher,
            },
        );
    }

    /// Drop every watch of a window (`<label>/…`).
    pub fn drop_window(&self, label: &str) {
        let prefix = format!("{label}/");
        self.inner
            .lock()
            .unwrap()
            .retain(|k, _| !k.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_changes_once_per_burst() {
        let dir = tempfile::tempdir().unwrap();
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let w = Watches::default();
        w.set(
            "main/1",
            Some(dir.path()),
            Arc::new(move |name, v| sink.lock().unwrap().push((name.to_string(), v))),
        );
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}")), "x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(700));
        let events = got.lock().unwrap().clone();
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "fs-changed");
        assert_eq!(events[0].1["key"], "main/1");
        w.drop_window("main");
        std::fs::write(dir.path().join("after"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(got.lock().unwrap().len(), 1);
    }
}
