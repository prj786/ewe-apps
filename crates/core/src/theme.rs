//! The ewe theme: `theme-tokens.json` v3, read and watched.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde_json::Value;

pub const FILE_NAME: &str = "theme-tokens.json";

/// `$XDG_CONFIG_HOME/quickshell/theme-tokens.json`.
pub fn tokens_path() -> PathBuf {
    crate::xdg::config_home().join("quickshell").join(FILE_NAME)
}

/// The parsed token file, or `None` when it is missing, unreadable or not version 3.
/// The webview does the CSS mapping (`parseEweTokens` in @ewe/ui), so the same JSON
/// crosses the bridge that ewe Browser's main process reads.
pub fn read(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    (value.get("version")?.as_u64()? == 3 && value.get("color")?.is_object()).then_some(value)
}

/// A running directory watcher; dropping it stops the thread.
pub struct ThemeWatch {
    _watcher: notify::RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

impl Drop for ThemeWatch {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

/// Watch the token file's directory (ewe-theme writes a temp file and renames it, so
/// the file itself is a moving target) and call `on_change` with the fresh contents,
/// 200 ms after the last event. `None` when the directory does not exist.
pub fn watch<F>(path: PathBuf, on_change: F) -> Option<ThemeWatch>
where
    F: Fn(Option<Value>) + Send + 'static,
{
    let dir = path.parent()?.to_path_buf();
    if !dir.is_dir() {
        return None;
    }
    let (tx, rx) = mpsc::channel::<()>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let file_name = path.file_name()?.to_os_string();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let ours = event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|p| p.file_name() == Some(file_name.as_os_str()));
        if ours {
            let _ = tx.send(());
        }
    })
    .ok()?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).ok()?;
    std::thread::Builder::new()
        .name("ewe-theme-watch".into())
        .spawn(move || {
            loop {
                // wait for an event, then swallow the burst that follows it
                match rx.recv() {
                    Ok(()) => {}
                    Err(_) => return,
                }
                loop {
                    if stop_rx.try_recv().is_ok() {
                        return;
                    }
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if stop_rx.try_recv().is_ok() {
                    return;
                }
                on_change(read(&path));
            }
        })
        .ok()?;
    Some(ThemeWatch {
        _watcher: watcher,
        stop: stop_tx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn reads_only_version_3() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(FILE_NAME);
        std::fs::write(&p, r##"{"version":3,"color":{"accent":"#eeb407"}}"##).unwrap();
        assert_eq!(read(&p).unwrap()["color"]["accent"], "#eeb407");
        std::fs::write(&p, r#"{"version":2,"color":{}}"#).unwrap();
        assert!(read(&p).is_none());
        std::fs::write(&p, "nope").unwrap();
        assert!(read(&p).is_none());
        assert!(read(&dir.path().join("missing.json")).is_none());
    }

    #[test]
    fn picks_up_an_atomic_rename() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(FILE_NAME);
        let seen = Arc::new(Mutex::new(Vec::<Option<Value>>::new()));
        let sink = seen.clone();
        let _w = watch(p.clone(), move |v| sink.lock().unwrap().push(v)).unwrap();
        let tmp = dir.path().join("theme-tokens.json.tmp");
        std::fs::write(&tmp, r##"{"version":3,"color":{"accent":"#111111"}}"##).unwrap();
        std::fs::rename(&tmp, &p).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let got = seen.lock().unwrap();
        assert!(!got.is_empty(), "no change seen");
        assert_eq!(got[0].as_ref().unwrap()["color"]["accent"], "#111111");
    }
}
