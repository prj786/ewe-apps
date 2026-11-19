//! Small actions: a terminal here, set as wallpaper, run a program, install an
//! AppImage with Komble, ewe-sync hand-offs.

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
}
