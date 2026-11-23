//! eep's side of ewe Files (`eep/docs/CARD.md`): what eep is installing right now (its
//! activity file, followed), what a card is before its app is installed (`eep card`),
//! and Install (`eep add`: the card moves into Applications and its app is fetched).
//! Starting an app is [`crate::misc::eep_open`].

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use ewe_app_core::eep::{self, Activity, AppCard};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;

use crate::ops::Emit;

/// While something is in flight the file is read again this often even when it did
/// not change: an eep that was killed says nothing more, and its entry has to go.
const LIVENESS: Duration = Duration::from_secs(3);

/// What eep is installing right now.
pub fn activity() -> Vec<Activity> {
    eep::read_activity(&eep::activity_file())
}

/// Follow eep's activity file: `eep-activity [entries]` whenever what it says changes.
pub fn watch_activity(emit: Emit) {
    watch_activity_at(eep::activity_file(), emit);
}

fn watch_activity_at(file: PathBuf, emit: Emit) {
    std::thread::spawn(move || {
        let Some(dir) = file.parent().map(Path::to_path_buf) else {
            return;
        };
        // eep makes the folder when it first installs something; a watch needs it now
        let _ = std::fs::create_dir_all(&dir);
        let (tx, rx) = mpsc::channel::<()>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // notify reports reads too (OPEN): only changes count
            if let Ok(e) = res
                && !matches!(e.kind, notify::EventKind::Access(_))
            {
                let _ = tx.send(());
            }
        });
        // No watch (out of inotify watches): look every few seconds instead — an
        // install must never show as stuck because nobody is told.
        let mut watcher = watcher.ok();
        let watching = watcher
            .as_mut()
            .is_some_and(|w| w.watch(&dir, RecursiveMode::NonRecursive).is_ok());
        let mut last = eep::read_activity(&file);
        loop {
            if !watching {
                std::thread::sleep(LIVENESS);
            } else if last.is_empty() {
                if rx.recv().is_err() {
                    return;
                }
            } else if matches!(
                rx.recv_timeout(LIVENESS),
                Err(mpsc::RecvTimeoutError::Disconnected)
            ) {
                return;
            }
            // one write by eep is several events (a temp file, then a rename)
            while rx.try_recv().is_ok() {}
            let now = eep::read_activity(&file);
            if now != last {
                emit("eep-activity", serde_json::json!(now));
                last = now;
            }
        }
    });
}

/// What the Install view shows of a card: the app as a row has it, and what eep says
/// about it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub path: String,
    /// for the icon's URL (`/app-icon?m=`)
    pub mtime: i64,
    pub app: AppCard,
    /// eep's `eep card <file>`: `installed` (the card that holds this app in
    /// Applications), `ready`, `download` (bytes an install would fetch now)…; null
    /// without eep, or when eep does not take the card
    pub info: Option<serde_json::Value>,
}

pub fn card_info(path: &Path) -> Result<CardInfo, String> {
    let entry = crate::fs::entry_for(path).ok_or("It no longer exists")?;
    let app = entry.app.ok_or("This file is not an app")?;
    let info = crate::places::tool_path("eep").and_then(|eep| card_json(&eep, path));
    Ok(CardInfo {
        path: entry.path,
        mtime: entry.mtime,
        app,
        info,
    })
}

fn card_json(eep: &Path, card: &Path) -> Option<serde_json::Value> {
    let out = Command::new(eep)
        .arg("card")
        .arg(card)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&out.stdout)
        .ok()
        .filter(|v| v["ok"] == true)
}

/// What `eep add` answered when it was done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Added {
    pub ok: bool,
    /// why not, in short words
    pub error: Option<String>,
    /// the app's card in Applications
    pub card: Option<String>,
    pub app_id: Option<String>,
}

/// eep's one line → [`Added`]. No JSON at all is a failure too (eep was killed).
pub fn added(line: &str) -> Added {
    let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
    let text = |key: &str| v[key].as_str().map(str::to_string);
    let ok = v["ok"] == true;
    Added {
        ok,
        error: (!ok).then(|| {
            crate::misc::eep_error(line).unwrap_or_else(|| "The install did not finish".into())
        }),
        card: text("card"),
        app_id: text("id"),
    }
}

/// `eep add <card>` (eep/docs/CARD.md): the card moves into Applications when it is
/// elsewhere, and its app is installed — not started. `done` gets eep's answer when
/// the install ends; how far it is comes through the activity file meanwhile.
pub fn add(card: &Path, done: impl FnOnce(Added) + Send + 'static) -> Result<(), String> {
    if !card.is_file() {
        return Err("It no longer exists".into());
    }
    let eep = crate::places::tool_path("eep").ok_or("eep is not installed")?;
    add_with(&eep, card, done)
}

/// A small `sh` in its own session hands us eep's line: the install goes on when the
/// window (or Files) closes, and eep never writes its answer into a dead pipe. One
/// line is all eep ever prints on stdout (its rule: one JSON object, exit 0; Nix's
/// progress goes to stderr).
const EEP_ADD_SH: &str =
    r#""$0" add "$1" | { trap '' PIPE; IFS= read -r line; printf '%s\n' "$line"; }"#;

fn add_with(
    eep: &Path,
    card: &Path,
    done: impl FnOnce(Added) + Send + 'static,
) -> Result<(), String> {
    let mut c = Command::new("sh");
    c.arg("-c")
        .arg(EEP_ADD_SH)
        .arg(eep)
        .arg(card)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        use std::os::unix::process::CommandExt;
        c.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let out = child.stdout.take();
    // never on the UI: the line comes when the download is done
    std::thread::spawn(move || {
        let mut line = String::new();
        if let Some(out) = out {
            use std::io::{BufRead, Read};
            let _ = std::io::BufReader::new(out.take(64 * 1024)).read_line(&mut line);
        }
        done(added(&line));
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn eeps_answer_to_add() {
        let ok = added(
            r#"{"ok":true,"id":"blender","name":"Blender","card":"/home/you/Applications/Blender.eep","moved":true}"#,
        );
        assert!(ok.ok && ok.error.is_none());
        assert_eq!(ok.app_id.as_deref(), Some("blender"));
        assert_eq!(
            ok.card.as_deref(),
            Some("/home/you/Applications/Blender.eep")
        );
        let failed = added(
            r#"{"ok":false,"error":"No connection to the app server. Check the internet and try again.","id":"blender","card":"/home/you/Applications/Blender.eep"}"#,
        );
        assert!(!failed.ok);
        assert!(
            failed
                .error
                .as_deref()
                .unwrap()
                .starts_with("No connection")
        );
        assert_eq!(failed.app_id.as_deref(), Some("blender"), "still which app");
        // killed before it answered
        let none = added("");
        assert!(!none.ok && none.error.as_deref() == Some("The install did not finish"));
    }

    fn fake_eep(dir: &Path, body: &str) -> PathBuf {
        let eep = dir.join("eep");
        std::fs::write(&eep, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::props::chmod(&eep, 0o755).unwrap();
        eep
    }

    #[test]
    fn add_hands_over_eeps_line() {
        let dir = tempfile::tempdir().unwrap();
        let eep = fake_eep(
            dir.path(),
            r#"[ "$1" = add ] && printf '{"ok":true,"id":"x","card":"%s"}\n' "$2""#,
        );
        let card = dir.path().join("X.eep");
        std::fs::write(&card, "id = \"x\"\nname = \"X\"\n").unwrap();
        let (tx, rx) = mpsc::channel();
        add_with(&eep, &card, move |r| tx.send(r).unwrap()).unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(got.ok);
        assert_eq!(got.card.as_deref(), card.to_str());
        assert_eq!(
            add(&dir.path().join("Gone.eep"), |_| {}),
            Err("It no longer exists".into())
        );
    }

    #[test]
    fn activity_changes_are_emitted_once_each() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("eep/activity.json");
        let got = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = got.clone();
        watch_activity_at(
            file.clone(),
            Arc::new(move |name, v| {
                assert_eq!(name, "eep-activity");
                sink.lock().unwrap().push(v);
            }),
        );
        let wait = |n: usize| {
            for _ in 0..100 {
                if got.lock().unwrap().len() >= n {
                    return;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            panic!("{n} events expected, got {:?}", got.lock().unwrap());
        };
        // as eep writes it: a temp file renamed into place
        let write = |text: &str| {
            let tmp = file.with_file_name(".activity.json.tmp");
            std::fs::write(&tmp, text).unwrap();
            std::fs::rename(&tmp, &file).unwrap();
        };
        // the folder has to be there before the first write (the watcher makes it)
        for _ in 0..100 {
            if file.parent().unwrap().is_dir() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(100));
        let me = std::process::id();
        let entry = |done: u32| {
            format!(
                r#"{{"eep_activity":0,"updated":1,"apps":[{{"id":"a","name":"A","what":"install","state":"downloading","done":{done},"total":100,"pid":{me}}}]}}"#
            )
        };
        write(&entry(10));
        wait(1);
        assert_eq!(got.lock().unwrap()[0][0]["done"], 10);
        // the same again: nothing new to say
        write(&entry(10));
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(got.lock().unwrap().len(), 1);
        write(&entry(55));
        wait(2);
        // done: eep removes the file
        std::fs::remove_file(&file).unwrap();
        wait(3);
        assert_eq!(got.lock().unwrap()[2], serde_json::json!([]));
    }
}
