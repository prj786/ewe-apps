//! Start-up timing for `scripts/perf.sh`. With `EWE_APPS_TRACE=1` in the environment
//! every mark prints `trace <ms since the epoch> <label>` to stderr; without it a mark
//! costs one cached boolean. The page's marks come through the `trace_mark` command
//! with the page's own clock (`performance.timeOrigin + performance.now()`), so the two
//! sides read on one line of time.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("EWE_APPS_TRACE").is_some_and(|v| !v.is_empty()))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// A mark from the Rust side, now.
pub fn mark(label: &str) {
    if enabled() {
        eprintln!("trace {:.1} {label}", now_ms());
    }
}

/// A mark the page took at `at` (ms since the epoch).
pub fn mark_at(label: &str, at: f64) {
    if enabled() {
        eprintln!("trace {at:.1} page:{label}");
    }
}
