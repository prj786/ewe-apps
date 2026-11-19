//! Recursive search from a folder, streamed in batches (`search-results`), and
//! "Search everywhere" through `plocate`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Deserialize;

use crate::fs::{Entry, entry_for};
use crate::ops::Emit;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    /// case-insensitive substring of the name; `*` and `?` make it a pattern
    pub query: String,
    /// `folder` | `image` | `video` | `audio` | `document` | `archive` | `code` | `` (any)
    #[serde(default)]
    pub kind: String,
    /// modified within the last N days (0 = any)
    #[serde(default)]
    pub days: u64,
    #[serde(default)]
    pub min_size: u64,
    #[serde(default)]
    pub max_size: u64,
    #[serde(default)]
    pub hidden: bool,
}

const BATCH: usize = 40;
const MAX_RESULTS: usize = 5000;

pub struct Search {
    seq: AtomicU64,
    stop: std::sync::Mutex<Arc<AtomicBool>>,
}

impl Default for Search {
    fn default() -> Self {
        Search {
            seq: AtomicU64::new(1),
            stop: std::sync::Mutex::new(Arc::new(AtomicBool::new(false))),
        }
    }
}

fn ext_kind(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "svg" | "ico" | "tif"
        | "tiff" | "heic" | "heif" | "jxl" | "raw" | "cr2" | "nef" | "psd" | "xcf" => "image",
        "mp4" | "m4v" | "mkv" | "webm" | "mov" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "3gp"
        | "m2ts" | "ogv" => "video",
        "mp3" | "flac" | "ogg" | "oga" | "opus" | "wav" | "m4a" | "aac" | "wma" | "aiff"
        | "alac" | "mka" => "audio",
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "epub" | "xls" | "xlsx" | "ods" | "ppt"
        | "pptx" | "odp" | "txt" | "md" | "markdown" | "rst" | "csv" => "document",
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "7z" | "rar" | "lz4" | "deb"
        | "rpm" | "pkg" | "apk" | "jar" => "archive",
        "js" | "mjs" | "ts" | "tsx" | "jsx" | "json" | "html" | "css" | "scss" | "py" | "rb"
        | "go" | "rs" | "c" | "h" | "cpp" | "hpp" | "java" | "kt" | "swift" | "sh" | "lua"
        | "qml" | "php" | "sql" | "xml" | "vue" | "toml" | "yaml" | "yml" | "nix" => "code",
        _ => "other",
    }
}

/// `*` and `?` patterns, else a case-insensitive substring match.
pub fn name_matches(name: &str, query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return true;
    }
    let (n, q) = (name.to_lowercase(), q.to_lowercase());
    if q.contains('*') || q.contains('?') {
        return glob(&q, &n);
    }
    n.contains(&q)
}

fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn passes(entry: &Entry, f: &SearchFilters, now_ms: i64) -> bool {
    if !f.hidden && entry.hidden {
        return false;
    }
    if !name_matches(&entry.name, &f.query) {
        return false;
    }
    if !f.kind.is_empty() {
        let k = if entry.dir {
            "folder"
        } else {
            ext_kind(&entry.name)
        };
        if k != f.kind {
            return false;
        }
    }
    if f.days > 0 && entry.mtime < now_ms - (f.days as i64) * 86_400_000 {
        return false;
    }
    if !entry.dir {
        if f.min_size > 0 && entry.size < f.min_size {
            return false;
        }
        if f.max_size > 0 && entry.size > f.max_size {
            return false;
        }
    }
    true
}

impl Search {
    /// Start a search; results stream as `search-results {id, window, items, done}`.
    /// A new search stops the previous one.
    pub fn start(&self, root: PathBuf, filters: SearchFilters, window: String, emit: Emit) -> u64 {
        let stop = Arc::new(AtomicBool::new(false));
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let my_stop = stop.clone();
        // the previous search stops; the next start can stop this one
        let previous = std::mem::replace(&mut *self.stop.lock().unwrap(), stop);
        previous.store(true, Ordering::SeqCst);
        std::thread::Builder::new()
            .name("ewe-files-search".into())
            .spawn(move || run(id, root, filters, window, emit, my_stop))
            .expect("spawn search");
        id
    }

    pub fn stop(&self) {
        self.stop.lock().unwrap().store(true, Ordering::SeqCst);
    }
}

fn run(
    id: u64,
    root: PathBuf,
    f: SearchFilters,
    window: String,
    emit: Emit,
    stop: Arc<AtomicBool>,
) {
    let now = chrono::Utc::now().timestamp_millis();
    let mut batch: Vec<Entry> = Vec::new();
    let mut total = 0usize;
    let send = |items: Vec<Entry>, done: bool| {
        emit(
            "search-results",
            serde_json::json!({ "id": id, "window": window, "items": items, "done": done }),
        );
    };
    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            f.hidden || e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.')
        });
    for item in walker {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let Ok(item) = item else { continue };
        // trash folders and the like are not interesting results
        let Some(entry) = entry_for(item.path()) else {
            continue;
        };
        if passes(&entry, &f, now) {
            batch.push(entry);
            total += 1;
            if batch.len() >= BATCH {
                send(std::mem::take(&mut batch), false);
            }
            if total >= MAX_RESULTS {
                break;
            }
        }
    }
    if !stop.load(Ordering::Relaxed) {
        send(batch, true);
    }
}

/// `plocate` over the whole machine (the user's readable files), 500 at most.
pub fn everywhere(query: &str, limit: usize) -> Result<Vec<Entry>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    let out = std::process::Command::new("plocate")
        .args(["-i", "-l", &limit.to_string(), "--", q])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "plocate is not installed".to_string()
            } else {
                e.to_string()
            }
        })?;
    if !out.status.success() && out.stdout.is_empty() {
        // exit 1 = nothing found; anything else is a real problem (no database)
        return match out.status.code() {
            Some(1) => Ok(Vec::new()),
            _ => Err("plocate has no database yet (run updatedb)".into()),
        };
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter_map(|l| entry_for(Path::new(l)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn matches_names_and_globs() {
        assert!(name_matches("Report.PDF", "report"));
        assert!(name_matches("Report.PDF", "*.pdf"));
        assert!(name_matches("a1.txt", "a?.txt"));
        assert!(!name_matches("ab1.txt", "a?.txt"));
        assert!(name_matches("anything", ""));
        assert!(glob("*x*y", "aaxbby"));
        assert!(!glob("x*", "ax"));
    }

    #[test]
    fn filters_and_streams() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("docs/.hidden")).unwrap();
        std::fs::write(dir.path().join("docs/report.pdf"), vec![0; 2000]).unwrap();
        std::fs::write(dir.path().join("docs/notes.md"), "x").unwrap();
        std::fs::write(dir.path().join("docs/.hidden/report-secret.pdf"), "x").unwrap();
        std::fs::write(dir.path().join("photo.jpg"), "x").unwrap();
        type Batches = Vec<(Vec<Entry>, bool)>;
        let got: Arc<Mutex<Batches>> = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let emit: Emit = Arc::new(move |name, v| {
            assert_eq!(name, "search-results");
            let items: Vec<Entry> = v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| Entry {
                    name: i["name"].as_str().unwrap().into(),
                    path: i["path"].as_str().unwrap().into(),
                    kind: "file",
                    dir: i["dir"].as_bool().unwrap(),
                    size: i["size"].as_u64().unwrap(),
                    mtime: i["mtime"].as_i64().unwrap(),
                    hidden: i["hidden"].as_bool().unwrap(),
                    target: None,
                    mode: 0,
                })
                .collect();
            sink.lock()
                .unwrap()
                .push((items, v["done"].as_bool().unwrap()));
        });
        let s = Search::default();
        let f = SearchFilters {
            query: "report".into(),
            ..SearchFilters::default()
        };
        s.start(dir.path().to_path_buf(), f, "main".into(), emit.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !got.lock().unwrap().iter().any(|(_, d)| *d) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let all: Vec<Entry> = got
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(i, _)| i.clone())
            .collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "report.pdf");
        got.lock().unwrap().clear();

        let f = SearchFilters {
            query: String::new(),
            kind: "document".into(),
            hidden: true,
            min_size: 1000,
            ..SearchFilters::default()
        };
        s.start(dir.path().to_path_buf(), f, "main".into(), emit);
        while !got.lock().unwrap().iter().any(|(_, d)| *d) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let all: Vec<Entry> = got
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(i, _)| i.clone())
            .collect();
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(all[0].name, "report.pdf");
        let now = chrono::Utc::now().timestamp_millis();
        let e = entry_for(&dir.path().join("docs/.hidden/report-secret.pdf")).unwrap();
        assert!(passes(
            &e,
            &SearchFilters {
                hidden: true,
                days: 1,
                ..SearchFilters::default()
            },
            now
        ));
        let h = entry_for(&dir.path().join("docs/.hidden")).unwrap();
        assert!(!passes(
            &h,
            &SearchFilters {
                hidden: false,
                ..SearchFilters::default()
            },
            now
        ));
        assert_eq!(ext_kind("a.mkv"), "video");
    }
}
