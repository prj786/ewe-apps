//! The operations queue: copy, move, trash, delete, restore and empty-trash jobs,
//! each on its own thread, reporting bytes, speed and time left through an emit
//! callback (`op-progress`), pausable, cancellable, asking about name clashes
//! (Replace / Skip / Keep both, once or for all), with an undo journal shared with
//! the instant operations (rename, new folder).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::fs::{error_message, exists, is_inside, unique_path};
use crate::trash::{self, TrashEnv};

pub type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

const CHUNK: usize = 1024 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpKind {
    Copy,
    Move,
    Trash,
    Delete,
    Restore,
    EmptyTrash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    Replace,
    Skip,
    KeepBoth,
    Cancel,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub source: String,
    pub dest: String,
    pub source_size: u64,
    pub dest_size: u64,
    pub source_mtime: i64,
    pub dest_mtime: i64,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: u64,
    pub kind: OpKind,
    pub window: String,
    /// `queued` | `running` | `paused` | `waiting` | `done` | `failed` | `cancelled`
    pub state: &'static str,
    pub label: String,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub total_items: u64,
    pub done_items: u64,
    pub current: String,
    /// bytes per second
    pub speed: u64,
    /// seconds left, when known
    pub eta: Option<u64>,
    pub error: Option<String>,
    pub conflict: Option<Conflict>,
    /// what the job made: destination paths, trashed files, restored paths
    pub results: Vec<String>,
    pub undoable: bool,
    pub started: i64,
}

#[derive(Debug, Clone)]
pub struct OpRequest {
    pub kind: OpKind,
    pub sources: Vec<PathBuf>,
    pub dest: Option<PathBuf>,
    pub window: String,
    pub trash_env: TrashEnv,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum UndoAction {
    /// move `from` back to `to` (a unique name when `to` is taken again)
    Move { from: PathBuf, to: PathBuf },
    /// rename back
    Rename { from: PathBuf, to: PathBuf },
    /// remove what a copy created
    RemoveTree { path: PathBuf },
    /// remove a new, still empty folder or file
    RemoveEmpty { path: PathBuf },
    /// put a trashed item back
    Restore { trashed: PathBuf },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRecord {
    pub label: String,
    pub actions: Vec<UndoAction>,
}

#[derive(Default)]
struct Control {
    paused: bool,
    cancelled: bool,
    reply: Option<Resolution>,
    for_all: Option<Resolution>,
}

struct Job {
    control: Mutex<Control>,
    cv: Condvar,
    progress: Mutex<Progress>,
    emit: Emit,
    last_emit: Mutex<Instant>,
    run_started: Mutex<Option<Instant>>,
    paused_for: Mutex<Duration>,
}

#[derive(Debug)]
enum Stop {
    Cancelled,
    Io(io::Error),
}

impl From<io::Error> for Stop {
    fn from(e: io::Error) -> Stop {
        Stop::Io(e)
    }
}

impl Job {
    fn snapshot(&self) -> Progress {
        self.progress.lock().unwrap().clone()
    }

    fn emit_now(&self) {
        let p = self.snapshot();
        *self.last_emit.lock().unwrap() = Instant::now();
        (self.emit)("op-progress", serde_json::to_value(p).unwrap_or_default());
    }

    fn emit_throttled(&self) {
        if self.last_emit.lock().unwrap().elapsed() >= EMIT_EVERY {
            self.update_speed();
            self.emit_now();
        }
    }

    fn update_speed(&self) {
        let started = *self.run_started.lock().unwrap();
        let Some(started) = started else { return };
        let active = started
            .elapsed()
            .saturating_sub(*self.paused_for.lock().unwrap());
        let mut p = self.progress.lock().unwrap();
        let secs = active.as_secs_f64();
        if secs > 0.3 && p.done_bytes > 0 {
            p.speed = (p.done_bytes as f64 / secs) as u64;
            p.eta = if p.speed > 0 && p.total_bytes >= p.done_bytes {
                Some((p.total_bytes - p.done_bytes) / p.speed)
            } else {
                None
            };
        }
    }

    fn set_state(&self, state: &'static str) {
        self.progress.lock().unwrap().state = state;
        self.emit_now();
    }

    /// Wait while paused; `Err` when cancelled.
    fn checkpoint(&self) -> Result<(), Stop> {
        let mut c = self.control.lock().unwrap();
        if c.cancelled {
            return Err(Stop::Cancelled);
        }
        if c.paused {
            let since = Instant::now();
            drop(c);
            self.set_state("paused");
            c = self.control.lock().unwrap();
            while c.paused && !c.cancelled {
                c = self.cv.wait(c).unwrap();
            }
            *self.paused_for.lock().unwrap() += since.elapsed();
            if c.cancelled {
                return Err(Stop::Cancelled);
            }
            drop(c);
            self.set_state("running");
        }
        Ok(())
    }

    fn add_bytes(&self, n: u64) {
        self.progress.lock().unwrap().done_bytes += n;
        self.emit_throttled();
    }

    fn set_current(&self, path: &Path) {
        self.progress.lock().unwrap().current = path.to_string_lossy().into_owned();
        self.emit_throttled();
    }

    fn item_done(&self) {
        self.progress.lock().unwrap().done_items += 1;
        self.emit_throttled();
    }

    /// Ask what to do about `dest` existing (or apply the remembered answer).
    fn ask(&self, src: &Path, dest: &Path) -> Result<Resolution, Stop> {
        {
            let c = self.control.lock().unwrap();
            if c.cancelled {
                return Err(Stop::Cancelled);
            }
            if let Some(all) = c.for_all {
                return Ok(all);
            }
        }
        let sm = std::fs::symlink_metadata(src).ok();
        let dm = std::fs::symlink_metadata(dest).ok();
        {
            let mut p = self.progress.lock().unwrap();
            p.conflict = Some(Conflict {
                source: src.to_string_lossy().into_owned(),
                dest: dest.to_string_lossy().into_owned(),
                source_size: sm.as_ref().map(|m| m.len()).unwrap_or(0),
                dest_size: dm.as_ref().map(|m| m.len()).unwrap_or(0),
                source_mtime: sm
                    .as_ref()
                    .map(|m| crate::fs::ms(m.modified()))
                    .unwrap_or(0),
                dest_mtime: dm
                    .as_ref()
                    .map(|m| crate::fs::ms(m.modified()))
                    .unwrap_or(0),
                dir: dm.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            });
            p.state = "waiting";
        }
        self.emit_now();
        let waited = Instant::now();
        let mut c = self.control.lock().unwrap();
        while c.reply.is_none() && !c.cancelled {
            c = self.cv.wait(c).unwrap();
        }
        *self.paused_for.lock().unwrap() += waited.elapsed();
        let reply = c.reply.take();
        drop(c);
        self.progress.lock().unwrap().conflict = None;
        match reply {
            Some(Resolution::Cancel) | None => Err(Stop::Cancelled),
            Some(r) => {
                self.set_state("running");
                Ok(r)
            }
        }
    }
}

/// `a` and `b` are one file (the same inode: the same path, or a hard link).
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

/// Where a source should land, after asking about clashes. `None` = skip it.
fn place(job: &Job, src: &Path, dest: &Path) -> Result<Option<PathBuf>, Stop> {
    if !exists(dest) {
        return Ok(Some(dest.to_path_buf()));
    }
    // The thing itself is in the way (a copy pasted into its own folder): there is
    // nothing to ask, and "Replace" would delete the only copy before copying it.
    // It gets a name of its own, like Keep both.
    if same_file(src, dest) {
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(Some(unique_path(dest.parent().unwrap_or(dest), &name)));
    }
    match job.ask(src, dest)? {
        Resolution::Skip => Ok(None),
        Resolution::KeepBoth => {
            let name = dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(Some(unique_path(dest.parent().unwrap_or(dest), &name)))
        }
        Resolution::Replace => {
            let both_dirs = src.is_dir() && dest.is_dir() && !is_symlink(dest);
            if !both_dirs {
                trash::remove_any(dest)?;
            }
            Ok(Some(dest.to_path_buf()))
        }
        Resolution::Cancel => Err(Stop::Cancelled),
    }
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Bytes and items under `paths` (symlinks counted, not followed).
pub fn measure(paths: &[PathBuf]) -> (u64, u64) {
    let (mut bytes, mut items) = (0, 0);
    for p in paths {
        for e in walkdir::WalkDir::new(p).follow_links(false) {
            let Ok(e) = e else { continue };
            items += 1;
            if let Ok(m) = e.metadata()
                && m.is_file()
            {
                bytes += m.len();
            }
        }
    }
    (bytes, items)
}

fn copy_times_and_mode(src: &std::fs::Metadata, dest: &Path) {
    let _ = std::fs::set_permissions(dest, src.permissions());
    if let (Ok(a), Ok(m)) = (src.accessed(), src.modified())
        && let Ok(f) = std::fs::File::options().write(true).open(dest)
    {
        let _ = f.set_times(std::fs::FileTimes::new().set_accessed(a).set_modified(m));
    }
}

fn copy_file(job: &Job, src: &Path, dest: &Path, meta: &std::fs::Metadata) -> Result<(), Stop> {
    job.set_current(src);
    let mut input = std::fs::File::open(src)?;
    let mut output = std::fs::File::create(dest)?;
    let mut buf = vec![0u8; CHUNK];
    let mut pump = || -> Result<(), Stop> {
        loop {
            job.checkpoint()?;
            let n = io::Read::read(&mut input, &mut buf)?;
            if n == 0 {
                return Ok(());
            }
            io::Write::write_all(&mut output, &buf[..n])?;
            job.add_bytes(n as u64);
        }
    };
    let copied = pump();
    drop(output);
    if let Err(stop) = copied {
        // stopped half way, or the disk filled: half a file under the real name looks
        // like a finished copy
        let _ = std::fs::remove_file(dest);
        return Err(stop);
    }
    copy_times_and_mode(meta, dest);
    Ok(())
}

/// Copy `src` to `dest` (a path that may exist only when both are folders: merge).
fn copy_tree(job: &Job, src: &Path, dest: &Path) -> Result<(), Stop> {
    job.checkpoint()?;
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src)?;
        std::os::unix::fs::symlink(target, dest)?;
    } else if meta.is_dir() {
        match std::fs::create_dir(dest) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dest.is_dir() => {}
            Err(e) => return Err(e.into()),
        }
        let mut children: Vec<PathBuf> = std::fs::read_dir(src)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        children.sort();
        for child in children {
            let name = child.file_name().unwrap_or_default();
            let Some(target) = place(job, &child, &dest.join(name))? else {
                continue;
            };
            copy_tree(job, &child, &target)?;
        }
        copy_times_and_mode(&meta, dest);
    } else if meta.is_file() {
        copy_file(job, src, dest, &meta)?;
    }
    job.item_done();
    Ok(())
}

fn move_one(job: &Job, src: &Path, dest: &Path) -> Result<(), Stop> {
    job.checkpoint()?;
    job.set_current(src);
    let merging = src.is_dir() && dest.is_dir() && !is_symlink(dest);
    if !merging {
        match std::fs::rename(src, dest) {
            Ok(()) => {
                if let Ok(m) = std::fs::symlink_metadata(dest)
                    && m.is_file()
                {
                    job.add_bytes(m.len());
                }
                job.item_done();
                return Ok(());
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {}
            Err(e) => return Err(e.into()),
        }
    }
    if merging {
        // Child by child: what the person chose to skip stays where it was. (Copying
        // the folder and then removing the source deleted the skipped files too.)
        let mut children: Vec<PathBuf> = std::fs::read_dir(src)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        children.sort();
        for child in children {
            let name = child.file_name().unwrap_or_default();
            let Some(target) = place(job, &child, &dest.join(name))? else {
                continue;
            };
            move_one(job, &child, &target)?;
        }
        // gone when everything moved; it stays when something was skipped
        let _ = std::fs::remove_dir(src);
        job.item_done();
        return Ok(());
    }
    // another file system: copy, then remove the source
    copy_tree(job, src, dest)?;
    trash::remove_any(src)?;
    Ok(())
}

fn delete_tree(job: &Job, path: &Path) -> Result<(), Stop> {
    job.checkpoint()?;
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        let mut children: Vec<PathBuf> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        children.sort();
        for c in children {
            delete_tree(job, &c)?;
        }
        std::fs::remove_dir(path)?;
    } else {
        job.set_current(path);
        std::fs::remove_file(path)?;
    }
    job.item_done();
    Ok(())
}

fn label_for(req: &OpRequest) -> String {
    let n = req.sources.len();
    let what = if n == 1 {
        req.sources[0]
            .file_name()
            .map(|f| format!("“{}”", f.to_string_lossy()))
            .unwrap_or_else(|| "1 item".into())
    } else {
        format!("{n} items")
    };
    let to = |d: &Option<PathBuf>| {
        d.as_ref()
            .and_then(|d| d.file_name())
            .map(|f| format!(" to “{}”", f.to_string_lossy()))
            .unwrap_or_default()
    };
    match req.kind {
        OpKind::Copy => format!("Copying {what}{}", to(&req.dest)),
        OpKind::Move => format!("Moving {what}{}", to(&req.dest)),
        OpKind::Trash => format!("Moving {what} to Trash"),
        OpKind::Delete => format!("Deleting {what}"),
        OpKind::Restore => format!("Restoring {what}"),
        OpKind::EmptyTrash => "Emptying Trash".into(),
    }
}

fn run_job(job: &Job, req: &OpRequest) -> Result<Vec<UndoAction>, Stop> {
    let mut undo = Vec::new();
    let mut results = Vec::new();
    match req.kind {
        OpKind::Copy | OpKind::Move => {
            let dest_dir = req
                .dest
                .clone()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "No destination"))?;
            if !dest_dir.is_dir() {
                return Err(io::Error::new(io::ErrorKind::NotADirectory, "Not a folder").into());
            }
            let (bytes, items) = measure(&req.sources);
            {
                let mut p = job.progress.lock().unwrap();
                p.total_bytes = bytes;
                p.total_items = items;
            }
            job.set_state("running");
            *job.run_started.lock().unwrap() = Some(Instant::now());
            for src in &req.sources {
                let name = src
                    .file_name()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Cannot copy /"))?;
                if is_inside(&dest_dir, src) {
                    return Err(io::Error::other(format!(
                        "Cannot put “{}” inside itself",
                        name.to_string_lossy()
                    ))
                    .into());
                }
                if req.kind == OpKind::Move && src.parent() == Some(dest_dir.as_path()) {
                    continue;
                }
                let wanted = dest_dir.join(name);
                let Some(dest) = place(job, src, &wanted)? else {
                    continue;
                };
                if req.kind == OpKind::Copy {
                    copy_tree(job, src, &dest)?;
                    undo.push(UndoAction::RemoveTree { path: dest.clone() });
                } else {
                    move_one(job, src, &dest)?;
                    undo.push(UndoAction::Move {
                        from: dest.clone(),
                        to: src.clone(),
                    });
                }
                results.push(dest.to_string_lossy().into_owned());
            }
        }
        OpKind::Trash => {
            job.progress.lock().unwrap().total_items = req.sources.len() as u64;
            job.set_state("running");
            let now = chrono::Local::now().naive_local();
            for src in &req.sources {
                job.checkpoint()?;
                job.set_current(src);
                let t = trash::trash(&req.trash_env, src, now)?;
                undo.push(UndoAction::Restore {
                    trashed: PathBuf::from(&t.path),
                });
                results.push(t.path);
                job.item_done();
            }
        }
        OpKind::Delete => {
            let (_, items) = measure(&req.sources);
            job.progress.lock().unwrap().total_items = items;
            job.set_state("running");
            for src in &req.sources {
                delete_tree(job, src)?;
                results.push(src.to_string_lossy().into_owned());
            }
        }
        OpKind::Restore => {
            job.progress.lock().unwrap().total_items = req.sources.len() as u64;
            job.set_state("running");
            for src in &req.sources {
                job.checkpoint()?;
                job.set_current(src);
                let back = trash::restore(src)?;
                results.push(back.to_string_lossy().into_owned());
                job.item_done();
            }
        }
        OpKind::EmptyTrash => {
            let items = trash::list(&req.trash_env);
            job.progress.lock().unwrap().total_items = items.len() as u64;
            job.set_state("running");
            for e in items {
                job.checkpoint()?;
                job.set_current(Path::new(&e.path));
                trash::delete_forever(Path::new(&e.path))?;
                job.item_done();
            }
        }
    }
    job.progress.lock().unwrap().results = results;
    Ok(undo)
}

#[derive(Default)]
struct State {
    next_id: u64,
    jobs: HashMap<u64, Arc<Job>>,
    undo: Vec<UndoRecord>,
}

/// The queue. Clone it freely; it is one shared state.
#[derive(Clone)]
pub struct Ops {
    state: Arc<Mutex<State>>,
    emit: Emit,
}

impl Ops {
    pub fn new(emit: Emit) -> Ops {
        Ops {
            state: Arc::new(Mutex::new(State {
                next_id: 1,
                ..State::default()
            })),
            emit,
        }
    }

    /// Queue a job; it starts on its own thread at once.
    pub fn start(&self, req: OpRequest) -> u64 {
        let mut st = self.state.lock().unwrap();
        let id = st.next_id;
        st.next_id += 1;
        let job = Arc::new(Job {
            control: Mutex::new(Control::default()),
            cv: Condvar::new(),
            progress: Mutex::new(Progress {
                id,
                kind: req.kind,
                window: req.window.clone(),
                state: "queued",
                label: label_for(&req),
                total_bytes: 0,
                done_bytes: 0,
                total_items: 0,
                done_items: 0,
                current: String::new(),
                speed: 0,
                eta: None,
                error: None,
                conflict: None,
                results: Vec::new(),
                undoable: false,
                started: chrono::Utc::now().timestamp_millis(),
            }),
            emit: self.emit.clone(),
            last_emit: Mutex::new(Instant::now() - EMIT_EVERY),
            run_started: Mutex::new(None),
            paused_for: Mutex::new(Duration::ZERO),
        });
        st.jobs.insert(id, job.clone());
        drop(st);
        job.emit_now();
        let ops = self.clone();
        std::thread::Builder::new()
            .name(format!("ewe-files-op-{id}"))
            .spawn(move || {
                let outcome = run_job(&job, &req);
                // The undo record goes in BEFORE the job's progress is locked: `list()`
                // takes the two locks the other way round (the state, then each job),
                // and a job that finished while the page asked for the list left both
                // threads waiting for each other — every window frozen.
                let undoable = matches!(&outcome, Ok(undo) if !undo.is_empty());
                if let Ok(undo) = &outcome
                    && undoable
                {
                    let label = job.progress.lock().unwrap().label.clone();
                    ops.state.lock().unwrap().undo.push(UndoRecord {
                        label,
                        actions: undo.clone(),
                    });
                }
                let mut p = job.progress.lock().unwrap();
                match outcome {
                    Ok(_) => {
                        p.state = "done";
                        p.done_bytes = p.done_bytes.max(p.total_bytes);
                        p.eta = Some(0);
                        p.current = String::new();
                        p.undoable = undoable;
                    }
                    Err(Stop::Cancelled) => p.state = "cancelled",
                    Err(Stop::Io(e)) => {
                        p.state = "failed";
                        p.error = Some(error_message(&e));
                    }
                }
                drop(p);
                job.emit_now();
            })
            .expect("spawn op thread");
        id
    }

    fn with_control<R>(&self, id: u64, f: impl FnOnce(&Job, &mut Control) -> R) -> Option<R> {
        let job = self.state.lock().unwrap().jobs.get(&id)?.clone();
        let mut c = job.control.lock().unwrap();
        let r = f(&job, &mut c);
        job.cv.notify_all();
        Some(r)
    }

    pub fn pause(&self, id: u64) -> bool {
        self.with_control(id, |job, c| {
            c.paused = true;
            // show it at once (a job waiting on a read may be slow to notice)
            let mut p = job.progress.lock().unwrap();
            if p.state == "running" {
                p.state = "paused";
            }
        })
        .is_some()
    }

    pub fn resume(&self, id: u64) -> bool {
        self.with_control(id, |_, c| c.paused = false).is_some()
    }

    pub fn cancel(&self, id: u64) -> bool {
        self.with_control(id, |_, c| c.cancelled = true).is_some()
    }

    /// Answer the job's open question; `for_all` remembers it for this job.
    pub fn resolve(&self, id: u64, choice: Resolution, for_all: bool) -> bool {
        self.with_control(id, |_, c| {
            c.reply = Some(choice);
            if for_all && choice != Resolution::Cancel {
                c.for_all = Some(choice);
            }
        })
        .is_some()
    }

    // A job's progress is never locked while the state is: see the job thread.
    fn job(&self, id: u64) -> Option<Arc<Job>> {
        self.state.lock().unwrap().jobs.get(&id).cloned()
    }

    pub fn progress(&self, id: u64) -> Option<Progress> {
        self.job(id).map(|j| j.snapshot())
    }

    pub fn list(&self) -> Vec<Progress> {
        let jobs: Vec<Arc<Job>> = self.state.lock().unwrap().jobs.values().cloned().collect();
        let mut out: Vec<Progress> = jobs.iter().map(|j| j.snapshot()).collect();
        out.sort_by_key(|p| p.id);
        out
    }

    /// Forget a finished job.
    pub fn dismiss(&self, id: u64) {
        let Some(job) = self.job(id) else { return };
        if matches!(job.snapshot().state, "done" | "failed" | "cancelled") {
            self.state.lock().unwrap().jobs.remove(&id);
        }
    }

    /// Record an instant change (rename, new folder) so Ctrl+Z can take it back.
    pub fn push_undo(&self, record: UndoRecord) {
        let mut st = self.state.lock().unwrap();
        st.undo.push(record);
        if st.undo.len() > 50 {
            st.undo.remove(0);
        }
    }

    pub fn undo_label(&self) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .undo
            .last()
            .map(|r| r.label.clone())
    }

    /// Take back the last change. Returns its label and the paths touched.
    pub fn undo(&self) -> io::Result<Option<(String, Vec<PathBuf>)>> {
        let record = self.state.lock().unwrap().undo.pop();
        let Some(record) = record else {
            return Ok(None);
        };
        let mut touched = Vec::new();
        let mut first_error: Option<io::Error> = None;
        for action in record.actions.iter().rev() {
            let result = match action {
                UndoAction::Move { from, to } | UndoAction::Rename { from, to } => {
                    let target = if exists(to) {
                        let name = to
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        unique_path(to.parent().unwrap_or(to), &name)
                    } else {
                        to.clone()
                    };
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::rename(from, &target).map(|()| target)
                }
                UndoAction::RemoveTree { path } => trash::remove_any(path).map(|()| path.clone()),
                UndoAction::RemoveEmpty { path } => {
                    let r = if path.is_dir() {
                        std::fs::remove_dir(path)
                    } else {
                        match std::fs::metadata(path) {
                            Ok(m) if m.len() == 0 => std::fs::remove_file(path),
                            Ok(_) => Err(io::Error::other("The file is not empty any more")),
                            Err(e) => Err(e),
                        }
                    };
                    r.map(|()| path.clone())
                }
                UndoAction::Restore { trashed } => trash::restore(trashed),
            };
            match result {
                Ok(p) => touched.push(p),
                Err(e) if first_error.is_none() => first_error = Some(e),
                Err(_) => {}
            }
        }
        match first_error {
            Some(e) if touched.is_empty() => Err(e),
            _ => Ok(Some((record.label, touched))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops() -> Ops {
        Ops::new(Arc::new(|_, _| {}))
    }

    fn env(root: &Path) -> TrashEnv {
        TrashEnv {
            home_trash: root.join("Trash"),
            uid: 1000,
            mounts: vec![],
        }
    }

    fn wait_for(ops: &Ops, id: u64, states: &[&str]) -> Progress {
        let start = Instant::now();
        loop {
            let p = ops.progress(id).unwrap();
            if states.contains(&p.state) {
                return p;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "timeout in {}",
                p.state
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_conflict(ops: &Ops, id: u64, not_dest: &str) -> Conflict {
        let start = Instant::now();
        loop {
            let p = ops.progress(id).unwrap();
            if p.state == "waiting"
                && let Some(c) = p.conflict
                && c.dest != not_dest
            {
                return c;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "timeout waiting for a question"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn done(ops: &Ops, id: u64) -> Progress {
        let p = wait_for(ops, id, &["done", "failed", "cancelled"]);
        assert_eq!(p.state, "done", "{:?}", p.error);
        p
    }

    fn req(kind: OpKind, sources: Vec<PathBuf>, dest: Option<PathBuf>, root: &Path) -> OpRequest {
        OpRequest {
            kind,
            sources,
            dest,
            window: "main".into(),
            trash_env: env(root),
        }
    }

    fn tree(root: &Path) -> PathBuf {
        let src = root.join("src");
        std::fs::create_dir_all(src.join("deep/er")).unwrap();
        std::fs::write(src.join("a.txt"), "aaaa").unwrap();
        std::fs::write(src.join("deep/b.txt"), "bb").unwrap();
        std::fs::write(src.join("deep/er/c.txt"), "c").unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        src
    }

    #[test]
    fn a_copy_pasted_into_its_own_folder_is_a_second_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        std::fs::write(&a, "the only copy").unwrap();
        let o = ops();
        // no question is asked (Replace used to delete `a.txt` and then fail to copy it)
        let id = o.start(req(
            OpKind::Copy,
            vec![a.clone()],
            Some(dir.path().to_path_buf()),
            dir.path(),
        ));
        let p = done(&o, id);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "the only copy");
        let copy = dir.path().join("a (1).txt");
        assert_eq!(p.results, vec![copy.to_string_lossy()]);
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "the only copy");
    }

    #[test]
    fn a_folder_is_not_copied_into_itself() {
        let dir = tempfile::tempdir().unwrap();
        let src = tree(dir.path());
        let o = ops();
        let id = o.start(req(
            OpKind::Copy,
            vec![src.clone()],
            Some(src.clone()),
            dir.path(),
        ));
        let p = wait_for(&o, id, &["done", "failed", "cancelled"]);
        assert_eq!(p.state, "failed");
        assert!(p.error.unwrap().contains("inside itself"));
        assert!(!src.join("src").exists());
    }

    #[test]
    fn a_merge_keeps_what_was_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from/Photos");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(to.join("Photos")).unwrap();
        std::fs::write(from.join("a.jpg"), "mine").unwrap();
        std::fs::write(from.join("b.jpg"), "new").unwrap();
        std::fs::write(to.join("Photos/a.jpg"), "theirs").unwrap();
        let o = ops();
        let id = o.start(req(
            OpKind::Move,
            vec![from.clone()],
            Some(to.clone()),
            dir.path(),
        ));
        // the folders: merge
        let c = wait_conflict(&o, id, "");
        assert!(c.dir);
        o.resolve(id, Resolution::Replace, false);
        // a.jpg: skip it
        let c = wait_conflict(&o, id, &c.dest);
        assert!(c.dest.ends_with("a.jpg"));
        o.resolve(id, Resolution::Skip, false);
        done(&o, id);
        assert_eq!(
            std::fs::read_to_string(to.join("Photos/a.jpg")).unwrap(),
            "theirs"
        );
        assert_eq!(
            std::fs::read_to_string(to.join("Photos/b.jpg")).unwrap(),
            "new"
        );
        // the file the person chose to leave is still where it was
        assert_eq!(std::fs::read_to_string(from.join("a.jpg")).unwrap(), "mine");
        assert!(!from.join("b.jpg").exists());
    }

    #[test]
    fn a_stopped_copy_leaves_no_half_file() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![7u8; 6 * CHUNK]).unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let o = ops();
        let id = o.start(req(
            OpKind::Copy,
            vec![big.clone()],
            Some(dest.clone()),
            dir.path(),
        ));
        o.cancel(id);
        let p = wait_for(&o, id, &["done", "failed", "cancelled"]);
        if p.state == "cancelled" {
            assert!(!dest.join("big.bin").exists(), "half a file was left");
        } else {
            // the copy won the race with the stop: then it is whole
            assert_eq!(
                std::fs::metadata(dest.join("big.bin")).unwrap().len(),
                (6 * CHUNK) as u64
            );
        }
    }

    #[test]
    fn listing_while_jobs_finish_never_locks_up() {
        let dir = tempfile::tempdir().unwrap();
        let o = ops();
        let lister = {
            let o = o.clone();
            std::thread::spawn(move || {
                for _ in 0..4000 {
                    let _ = o.list();
                }
            })
        };
        for i in 0..150 {
            let f = dir.path().join(format!("f{i}.txt"));
            std::fs::write(&f, "x").unwrap();
            let id = o.start(req(OpKind::Trash, vec![f], None, dir.path()));
            done(&o, id);
        }
        lister.join().unwrap();
    }

    #[test]
    fn copies_a_tree_with_progress_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let src = tree(dir.path());
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let o = ops();
        let id = o.start(req(
            OpKind::Copy,
            vec![src.clone()],
            Some(dest.clone()),
            dir.path(),
        ));
        let p = done(&o, id);
        assert_eq!(p.total_bytes, 7);
        assert_eq!(p.done_bytes, 7);
        assert_eq!(p.total_items, 7);
        assert_eq!(p.done_items, 7);
        assert_eq!(p.results, vec![dest.join("src").to_string_lossy()]);
        assert!(p.undoable);
        assert_eq!(
            std::fs::read_to_string(dest.join("src/deep/er/c.txt")).unwrap(),
            "c"
        );
        assert_eq!(
            std::fs::read_link(dest.join("src/link")).unwrap(),
            PathBuf::from("a.txt")
        );
        assert!(src.exists());
        assert_eq!(o.undo_label().as_deref(), Some("Copying “src” to “dest”"));
        let (label, touched) = o.undo().unwrap().unwrap();
        assert!(label.starts_with("Copying"));
        assert_eq!(touched, vec![dest.join("src")]);
        assert!(!dest.join("src").exists());
        assert!(o.undo().unwrap().is_none());
    }

    #[test]
    fn moves_and_undoes() {
        let dir = tempfile::tempdir().unwrap();
        let src = tree(dir.path());
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let o = ops();
        let id = o.start(req(
            OpKind::Move,
            vec![src.clone()],
            Some(dest.clone()),
            dir.path(),
        ));
        done(&o, id);
        assert!(!src.exists() && dest.join("src/a.txt").is_file());
        o.undo().unwrap().unwrap();
        assert!(src.join("a.txt").is_file() && !dest.join("src").exists());
        // into itself is refused
        let id = o.start(req(
            OpKind::Move,
            vec![src.clone()],
            Some(src.join("deep")),
            dir.path(),
        ));
        let p = wait_for(&o, id, &["done", "failed", "cancelled"]);
        assert_eq!(p.state, "failed");
        assert!(p.error.unwrap().contains("inside itself"));
        // same folder is a no-op
        let id = o.start(req(
            OpKind::Move,
            vec![src.clone()],
            Some(dir.path().to_path_buf()),
            dir.path(),
        ));
        assert!(done(&o, id).results.is_empty());
    }

    #[test]
    fn conflicts_keep_both_replace_skip_and_for_all() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        for n in ["x.txt", "y.txt", "z.txt"] {
            std::fs::write(a.join(n), format!("new {n}")).unwrap();
            std::fs::write(b.join(n), "old").unwrap();
        }
        let o = ops();
        let sources = vec![a.join("x.txt"), a.join("y.txt"), a.join("z.txt")];
        let id = o.start(req(
            OpKind::Copy,
            sources.clone(),
            Some(b.clone()),
            dir.path(),
        ));
        let c = wait_conflict(&o, id, "");
        assert_eq!(c.dest, b.join("x.txt").to_string_lossy());
        assert_eq!(c.source_size, 9);
        assert_eq!(c.dest_size, 3);
        assert!(o.resolve(id, Resolution::KeepBoth, false));
        let c = wait_conflict(&o, id, &c.dest);
        assert_eq!(c.dest, b.join("y.txt").to_string_lossy());
        o.resolve(id, Resolution::Skip, false);
        let _ = wait_conflict(&o, id, &c.dest);
        o.resolve(id, Resolution::Replace, true);
        let p = done(&o, id);
        assert_eq!(std::fs::read_to_string(b.join("x.txt")).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(b.join("x (1).txt")).unwrap(),
            "new x.txt"
        );
        assert_eq!(std::fs::read_to_string(b.join("y.txt")).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(b.join("z.txt")).unwrap(),
            "new z.txt"
        );
        assert_eq!(p.results.len(), 2);

        // "replace for all" remembered inside a folder merge
        std::fs::write(a.join("x.txt"), "newer").unwrap();
        let id = o.start(req(
            OpKind::Copy,
            vec![a.clone()],
            Some(dir.path().join("b2")),
            dir.path(),
        ));
        assert_eq!(wait_for(&o, id, &["done", "failed"]).state, "failed"); // b2 missing
        std::fs::create_dir(dir.path().join("b2/")).unwrap();
        std::fs::create_dir(dir.path().join("b2/a")).unwrap();
        std::fs::write(dir.path().join("b2/a/x.txt"), "old").unwrap();
        let id = o.start(req(
            OpKind::Copy,
            vec![a.clone()],
            Some(dir.path().join("b2")),
            dir.path(),
        ));
        let p = wait_for(&o, id, &["waiting"]);
        assert!(p.conflict.unwrap().dir);
        o.resolve(id, Resolution::Replace, true); // merge the folder, replace inside
        done(&o, id);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b2/a/x.txt")).unwrap(),
            "newer"
        );
        assert!(dir.path().join("b2/a/y.txt").is_file());

        // cancel at a question
        let id = o.start(req(
            OpKind::Copy,
            vec![a.clone()],
            Some(dir.path().join("b2")),
            dir.path(),
        ));
        wait_for(&o, id, &["waiting"]);
        o.resolve(id, Resolution::Cancel, false);
        assert_eq!(
            wait_for(&o, id, &["cancelled", "done", "failed"]).state,
            "cancelled"
        );
    }

    #[test]
    fn pauses_resumes_and_cancels_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![7u8; 24 * 1024 * 1024]).unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        let o = ops();
        let id = o.start(req(
            OpKind::Copy,
            vec![big.clone()],
            Some(dest.clone()),
            dir.path(),
        ));
        o.pause(id);
        let p = wait_for(&o, id, &["paused", "done"]);
        if p.state == "paused" {
            let frozen = o.progress(id).unwrap().done_bytes;
            std::thread::sleep(Duration::from_millis(50));
            assert_eq!(o.progress(id).unwrap().done_bytes, frozen);
            o.resume(id);
        }
        let p = done(&o, id);
        assert_eq!(p.done_bytes, 24 * 1024 * 1024);
        assert_eq!(
            std::fs::metadata(dest.join("big.bin")).unwrap().len(),
            p.done_bytes
        );

        let id = o.start(req(
            OpKind::Copy,
            vec![big],
            Some(dir.path().join("out2")),
            dir.path(),
        ));
        std::fs::create_dir(dir.path().join("out2")).ok();
        o.cancel(id);
        let p = wait_for(&o, id, &["cancelled", "done", "failed"]);
        assert_ne!(p.state, "done");
        o.dismiss(id);
        assert!(o.progress(id).is_none());
    }

    #[test]
    fn trashes_restores_deletes_and_empties() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("gone.txt");
        std::fs::write(&f, "bye").unwrap();
        let o = ops();
        let id = o.start(req(OpKind::Trash, vec![f.clone()], None, dir.path()));
        let p = done(&o, id);
        assert!(!f.exists());
        let trashed = PathBuf::from(&p.results[0]);
        assert!(trashed.is_file());
        assert_eq!(trash::list(&env(dir.path())).len(), 1);
        // undo = restore
        o.undo().unwrap().unwrap();
        assert!(f.is_file());
        assert!(trash::list(&env(dir.path())).is_empty());
        // trash again, restore through a job
        let id = o.start(req(OpKind::Trash, vec![f.clone()], None, dir.path()));
        let p = done(&o, id);
        let id = o.start(req(
            OpKind::Restore,
            vec![PathBuf::from(&p.results[0])],
            None,
            dir.path(),
        ));
        let p = done(&o, id);
        assert_eq!(p.results, vec![f.to_string_lossy()]);
        // delete forever
        let d = dir.path().join("folder");
        std::fs::create_dir_all(d.join("x")).unwrap();
        std::fs::write(d.join("x/y"), "1").unwrap();
        let id = o.start(req(OpKind::Delete, vec![d.clone()], None, dir.path()));
        let p = done(&o, id);
        assert!(!d.exists());
        assert_eq!(p.done_items, 3);
        assert!(!p.undoable);
        // empty trash
        std::fs::write(&f, "bye").unwrap();
        done(
            &o,
            o.start(req(OpKind::Trash, vec![f.clone()], None, dir.path())),
        );
        done(
            &o,
            o.start(req(OpKind::EmptyTrash, vec![], None, dir.path())),
        );
        assert!(trash::list(&env(dir.path())).is_empty());
    }

    #[test]
    fn undoes_renames_and_new_folders() {
        let dir = tempfile::tempdir().unwrap();
        let o = ops();
        let folder = crate::fs::mkdir(dir.path(), "New folder").unwrap();
        o.push_undo(UndoRecord {
            label: "New folder".into(),
            actions: vec![UndoAction::RemoveEmpty {
                path: folder.clone(),
            }],
        });
        let f = dir.path().join("a.txt");
        std::fs::write(&f, "1").unwrap();
        let renamed = crate::fs::rename(&f, "b.txt").unwrap();
        o.push_undo(UndoRecord {
            label: "Rename".into(),
            actions: vec![UndoAction::Rename {
                from: renamed.clone(),
                to: f.clone(),
            }],
        });
        assert_eq!(o.undo_label().as_deref(), Some("Rename"));
        o.undo().unwrap();
        assert!(f.is_file() && !renamed.exists());
        // a no-longer-empty folder cannot be undone away
        std::fs::write(folder.join("kept"), "x").unwrap();
        assert!(o.undo().is_err());
        assert!(folder.is_dir());
    }
}
