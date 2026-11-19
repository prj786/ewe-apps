//! A frame of the video as PNG in `~/Pictures/Screenshots` (XDG_PICTURES_DIR honoured),
//! taken by ffmpeg at the time the webview is showing — exact, every codec, no CORS.

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn screenshots_dir() -> PathBuf {
    crate::userdirs::user_dir("PICTURES", "Pictures").join("Screenshots")
}

/// `Movie 0-01-23.456.png`, numbered when it exists.
pub fn target_name(dir: &Path, video: &Path, seconds: f64) -> PathBuf {
    let stem = video
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "frame".into());
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let h = total_ms / 3_600_000;
    let m = (total_ms % 3_600_000) / 60_000;
    let s = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    let base = format!("{stem} {h}-{m:02}-{s:02}.{ms:03}");
    let mut candidate = dir.join(format!("{base}.png"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base} ({n}).png"));
        n += 1;
    }
    candidate
}

pub fn grab(video: &Path, seconds: f64) -> Result<PathBuf, String> {
    let dir = screenshots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let out = target_name(&dir, video, seconds);
    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-ss", &format!("{seconds:.3}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    if status.success() && out.is_file() {
        Ok(out)
    } else {
        let _ = std::fs::remove_file(&out);
        Err("ffmpeg could not decode this frame".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_shots_by_time_and_avoids_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let v = Path::new("/v/Sunrise Timelapse.mp4");
        let first = target_name(dir.path(), v, 83.4567);
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            "Sunrise Timelapse 0-01-23.457.png"
        );
        std::fs::write(&first, b"x").unwrap();
        let second = target_name(dir.path(), v, 83.4567);
        assert_eq!(
            second.file_name().unwrap().to_string_lossy(),
            "Sunrise Timelapse 0-01-23.457 (2).png"
        );
    }
}
