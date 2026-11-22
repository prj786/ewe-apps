//! Small actions: a terminal here, set as wallpaper, run a program, install an
//! AppImage with Komble, open an eep card, ewe-sync hand-offs.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const TERMINALS: &[&str] = &[
    "kitty",
    "foot",
    "alacritty",
    "wezterm",
    "ghostty",
    "gnome-terminal",
    "konsole",
    "xterm",
];

pub fn on_path(tool: &str) -> Option<PathBuf> {
    if tool.contains('/') {
        return Path::new(tool).is_file().then(|| PathBuf::from(tool));
    }
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(tool))
            .find(|p| p.is_file())
    })
}

fn detach(mut cmd: Command) -> std::io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // its own session, so closing the file manager never takes it along
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

/// `ewe-terminal-here <dir>` when installed, else `$TERMINAL` or the first known
/// terminal, started in `dir`.
pub fn open_terminal(dir: &Path) -> Result<String, String> {
    if let Some(here) = on_path("ewe-terminal-here") {
        let mut c = Command::new(here);
        c.arg(dir);
        return detach(c)
            .map(|()| "ewe-terminal-here".into())
            .map_err(|e| e.to_string());
    }
    let preferred = std::env::var("TERMINAL").ok();
    let candidates = preferred
        .iter()
        .map(String::as_str)
        .chain(TERMINALS.iter().copied());
    for name in candidates {
        let Some(bin) = on_path(name) else { continue };
        let mut c = Command::new(&bin);
        c.current_dir(dir);
        if detach(c).is_ok() {
            return Ok(name.to_string());
        }
    }
    Err("No terminal found".into())
}

/// What Nemo's "Set as Wallpaper" action ran (`ewe/system/nemo-actions/
/// ewe-set-wallpaper.sh`): `ewe-conf set desktop.wallpapers.default "<json path>"`,
/// then `~/.config/hypr/scripts/wallpaper.sh --reapply`.
pub fn set_wallpaper(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("It no longer exists".into());
    }
    let conf = crate::places::tool_path("ewe-conf").ok_or("ewe-conf is not installed")?;
    let value = serde_json::to_string(&path.to_string_lossy()).map_err(|e| e.to_string())?;
    let status = Command::new(conf)
        .args(["set", "desktop.wallpapers.default", &value])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Could not set the wallpaper".into()
        } else {
            err
        });
    }
    let script = ewe_app_core::xdg::config_home().join("hypr/scripts/wallpaper.sh");
    if script.is_file() {
        let mut c = Command::new(script);
        c.arg("--reapply");
        let _ = detach(c);
    }
    Ok(())
}

/// Start a program (an executable file or an AppImage), detached.
pub fn run_executable(path: &Path, in_terminal: bool) -> Result<(), String> {
    if in_terminal {
        let term = std::env::var("TERMINAL")
            .ok()
            .filter(|t| on_path(t).is_some())
            .or_else(|| {
                TERMINALS
                    .iter()
                    .find(|t| on_path(t).is_some())
                    .map(|t| t.to_string())
            })
            .ok_or("No terminal found")?;
        let mut c = Command::new(term);
        c.arg("-e").arg(path);
        if let Some(dir) = path.parent() {
            c.current_dir(dir);
        }
        return detach(c).map_err(|e| e.to_string());
    }
    let mut c = Command::new(path);
    if let Some(dir) = path.parent() {
        c.current_dir(dir);
    }
    detach(c).map_err(|e| crate::fs::error_message(&e))
}

/// `komble <file>`: Komble installs the AppImage or package.
pub fn komble_install(path: &Path) -> Result<(), String> {
    let komble = on_path("komble").ok_or("Komble is not installed")?;
    let mut c = Command::new(komble);
    c.arg(path);
    detach(c).map_err(|e| e.to_string())
}

/// `eep open <card>` (eep/docs/CARD.md): copies the card into ~/Applications when it is
/// elsewhere, installs what it names and becomes the app. `on_error` gets eep's error in
/// words when it could not (it prints one `{"ok":false,"error":…}` line and exits 0).
pub fn eep_open(card: &Path, on_error: impl FnOnce(String) + Send + 'static) -> Result<(), String> {
    if !card.is_file() {
        return Err("It no longer exists".into());
    }
    let eep = crate::places::tool_path("eep").ok_or("eep is not installed")?;
    eep_open_with(&eep, card, on_error)
}

/// On success eep execs the app, which keeps eep's stdout — so that is never our pipe
/// alone: a small `sh` in its own session hands us the first line and then drains the
/// rest into /dev/null for as long as the app runs (Files closing never leaves the app
/// writing into a dead pipe; SIGPIPE is ignored in the drain only, not in the app).
const EEP_OPEN_SH: &str = r#""$0" open "$1" | { trap '' PIPE; IFS= read -r line; printf '%s\n' "$line"; exec >/dev/null; exec cat; }"#;

fn eep_open_with(
    eep: &Path,
    card: &Path,
    on_error: impl FnOnce(String) + Send + 'static,
) -> Result<(), String> {
    let mut c = Command::new("sh");
    c.arg("-c")
        .arg(EEP_OPEN_SH)
        .arg(eep)
        .arg(card)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // its own session, so closing the file manager never takes the app along
    unsafe {
        use std::os::unix::process::CommandExt;
        c.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let out = child.stdout.take();
    // never on the UI: the line comes when eep gives up (or the app prints, or ends)
    std::thread::spawn(move || {
        let mut line = String::new();
        if let Some(out) = out {
            use std::io::{BufRead, Read};
            let _ = std::io::BufReader::new(out.take(64 * 1024)).read_line(&mut line);
        }
        if let Some(error) = eep_error(&line) {
            on_error(error);
        }
        // reap the sh when the app is gone
        let _ = child.wait();
    });
    Ok(())
}

/// eep's answer → its error in plain, short words; `None` when it is no failure (the
/// app's own output, nothing, or `"ok": true`).
pub fn eep_error(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("ok")?.as_bool()? {
        return None;
    }
    let text = v
        .get("error")
        .and_then(|e| e.as_str())
        .and_then(|e| e.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or("Could not open the app");
    const MAX: usize = 160;
    Some(match text.char_indices().nth(MAX) {
        Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        None => text.to_string(),
    })
}

/// `ewe-sync --pane <pane>` or `--add-folder <path>`; false when ewe-sync is missing.
pub fn ewe_sync(args: &[&str]) -> bool {
    let Some(bin) = crate::places::tool_path("ewe-sync") else {
        return false;
    };
    let mut c = Command::new(bin);
    c.args(args);
    detach(c).is_ok()
}

pub fn ewe_sync_available() -> bool {
    crate::places::tool_path("ewe-sync").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_tools() {
        assert!(on_path("sh").is_some());
        assert!(on_path("definitely-not-a-tool-xyz").is_none());
        assert!(on_path("/bin/sh").is_some());
    }

    #[test]
    fn runs_a_script_detached() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hello.sh");
        let marker = dir.path().join("ran");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        crate::props::chmod(&script, 0o755).unwrap();
        run_executable(&script, false).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(run_executable(&dir.path().join("missing"), false).is_err());
    }

    #[test]
    fn opens_only_cards_that_exist() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            eep_open(&dir.path().join("Gone.eep"), |_| {}),
            Err("It no longer exists".to_string())
        );
    }

    #[test]
    fn reads_eeps_error_in_words() {
        assert_eq!(
            eep_error(r#"{"ok":false,"error":"no network: dns"}"#).as_deref(),
            Some("no network: dns")
        );
        assert_eq!(
            eep_error("{\"ok\":false}\n").as_deref(),
            Some("Could not open the app")
        );
        let long = format!(r#"{{"ok":false,"error":"{}"}}"#, "é".repeat(400));
        let short = eep_error(&long).unwrap();
        assert!(short.ends_with('…') && short.chars().count() == 161);
        assert_eq!(eep_error(r#"{"ok":true}"#), None);
        assert_eq!(eep_error(""), None);
        assert_eq!(eep_error("Gtk-Message: started\n"), None);
    }

    fn fake_eep(dir: &Path, body: &str) -> PathBuf {
        let eep = dir.join("eep");
        std::fs::write(&eep, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::props::chmod(&eep, 0o755).unwrap();
        eep
    }

    #[test]
    fn eep_open_reports_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let eep = fake_eep(
            dir.path(),
            r#"[ "$1" = open ] && echo '{"ok":false,"error":"Firefox needs 300 MB more space"}'"#,
        );
        let card = dir.path().join("Firefox.eep");
        std::fs::write(&card, "").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        eep_open_with(&eep, &card, move |e| tx.send(e).unwrap()).unwrap();
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(got, "Firefox needs 300 MB more space");
    }

    #[test]
    fn eep_open_drains_the_apps_output() {
        // success: eep becomes the app; it prints far more than a pipe holds and must
        // never block or hear an error from us
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("app-finished");
        let eep = fake_eep(
            dir.path(),
            &format!(
                "i=0; while [ $i -lt 20000 ]; do echo \"app line $i of its own output\"; i=$((i+1)); done; touch '{}'",
                marker.display()
            ),
        );
        let card = dir.path().join("App.eep");
        std::fs::write(&card, "").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        eep_open_with(&eep, &card, move |e| tx.send(e).unwrap()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline, "the app blocked");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(200))
                .is_err()
        );
    }
}
