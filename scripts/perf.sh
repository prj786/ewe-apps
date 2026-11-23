#!/usr/bin/env bash
# How long a built app takes to show what it was asked for. Launches it inside a headless
# cage (nothing appears on the real screen, its own session bus) with EWE_APPS_TRACE=1,
# waits for the last mark, and prints every mark as milliseconds since the launch —
# several runs, then the median of each.
#
#   scripts/perf.sh <binary> <theme-dir|-> [app args…]
#
#   PERF_RUNS   how many launches (default 5; the first is the cold one)
#   PERF_MARK   the mark that ends a run (default: page:painted or page:ready)
#   PERF_LIMIT  seconds to wait for it (default 20)
#
# Marks: main (Rust main), setup, window, setup-done, page:script (the page's module
# ran), page:listed / page:painted (ewe Files: the first folder is in, and drawn),
# page:ready (ewe Viewer: the picture or the first PDF page is drawn). The numbers are
# for comparing one build with another on the same machine: cage draws with pixman here.
set -euo pipefail
bin=$1; theme=$2; shift 2
[ -x "$bin" ] || { echo "no binary $bin" >&2; exit 1; }
runs=${PERF_RUNS:-5}
mark=${PERF_MARK:-page:painted|page:ready}
limit=${PERF_LIMIT:-20}
work=$(mktemp -d "${TMPDIR:-/tmp}/ewe-perf.XXXXXX")
trap 'rm -rf "$work"' EXIT
cfg_env=()
if [ "$theme" != "-" ]; then cfg_env=(XDG_CONFIG_HOME="$theme"); fi

for i in $(seq 1 "$runs"); do
  rt=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/ewe-perf.XXXXXX"); chmod 700 "$rt"
  env -i HOME="$HOME" PATH="$PATH" XDG_RUNTIME_DIR="$rt" WLR_BACKENDS=headless WLR_RENDERER=pixman \
    WLR_LIBINPUT_NO_DEVICES=1 LANG="${LANG:-C.UTF-8}" "${cfg_env[@]}" EWE_APPS_TRACE=1 \
    LOG="$work/run-$i.log" MARK="$mark" LIMIT="$limit" \
    dbus-run-session -- cage -- bash -c '
      t0=$(date +%s%3N)
      echo "trace $t0 exec" > "$LOG"
      "$0" "$@" >> "$LOG" 2>&1 &
      app=$!
      for _ in $(seq 1 $((LIMIT * 20))); do
        grep -qE "^trace [0-9.]+ ($MARK)\$" "$LOG" && break
        sleep 0.05
      done
      kill $app 2>/dev/null; wait $app 2>/dev/null || true
    ' "$bin" "$@" >/dev/null 2>&1 || true
  for m in "$rt/doc" "$rt/gvfs"; do fusermount3 -uz "$m" 2>/dev/null || true; done
  rm -rf "$rt" 2>/dev/null || true
  awk -v run="$i" '
    $1 == "trace" && $3 == "exec" { t0 = $2; next }
    $1 == "trace" { printf "%s=%d ", $3, $2 - t0 }
    END { print "" }
  ' "$work/run-$i.log" | sed "s/^/run $i: /"
done

# the median of every mark over the runs
awk '
  FNR == 1 { t0 = 0 }
  $1 == "trace" && $3 == "exec" { t0 = $2; next }
  $1 == "trace" && !(FILENAME SUBSEP $3 in seen) {
    seen[FILENAME SUBSEP $3] = 1
    n[$3]++; v[$3, n[$3]] = $2 - t0
    if (!($3 in order)) { order[$3] = ++k; name[k] = $3 }
  }
  END {
    printf "median:"
    for (i = 1; i <= k; i++) {
      m = name[i]; c = n[m]
      for (a = 1; a <= c; a++) for (b = a + 1; b <= c; b++)
        if (v[m, b] < v[m, a]) { t = v[m, a]; v[m, a] = v[m, b]; v[m, b] = t }
      printf " %s=%d", m, v[m, int((c + 1) / 2)]
    }
    print ""
  }
' "$work"/run-*.log
