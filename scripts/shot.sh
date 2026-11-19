#!/usr/bin/env bash
# Launch a built app inside a headless cage compositor (nothing appears on the
# real screen), under its own session bus (single-instance never reaches the
# live desktop), with a given theme, and screenshot it with grim. Prints the
# RSS/PSS of the app and its WebKit helper processes, then closes it.
#
#   scripts/shot.sh <binary> <theme-dir|-> <out.png> [app args…]
#
# <theme-dir> is an XDG_CONFIG_HOME holding quickshell/theme-tokens.json; `-`
# keeps the real one (read-only). Make one with
#   ewe/bin/ewe-theme build --conf /nonexistent --scheme ewe-light \
#     --json "$dir/quickshell/theme-tokens.json" --css /dev/null
# SHOT_WAIT (seconds, default 1.5) is how long the window gets to settle.
# SHOT_KEEP=1 leaves the app running (for curl against the media server) until
# the file $OUT.done appears — see AGENTS.md. EWE_APPS_MEDIA_SERVER_FILE=<path> makes
# the app write its media server's {port, token} there (for curl).
set -euo pipefail
bin=$1; theme=$2; out=$3; shift 3
[ -x "$bin" ] || { echo "no binary $bin" >&2; exit 1; }
rt=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/ewe-shot.XXXXXX")
chmod 700 "$rt"
cleanup() {
  # the document portal and gvfs mount fuse dirs inside the session's runtime dir
  for m in "$rt/doc" "$rt/gvfs"; do fusermount3 -uz "$m" 2>/dev/null || true; done
  rm -rf "$rt" 2>/dev/null || true
}
trap cleanup EXIT
cfg_env=()
if [ "$theme" != "-" ]; then cfg_env=(XDG_CONFIG_HOME="$theme"); fi

env -i HOME="$HOME" PATH="$PATH" XDG_RUNTIME_DIR="$rt" WLR_BACKENDS=headless WLR_RENDERER=pixman \
  WLR_LIBINPUT_NO_DEVICES=1 LANG="${LANG:-C.UTF-8}" "${cfg_env[@]}" \
  SHOT_WAIT="${SHOT_WAIT:-1.5}" SHOT_KEEP="${SHOT_KEEP:-}" OUT="$out" \
  EWE_APPS_MEDIA_SERVER_FILE="${EWE_APPS_MEDIA_SERVER_FILE:-}" \
  dbus-run-session -- cage -- bash -c '
    "$0" "$@" > "$OUT.log" 2>&1 &
    app=$!
    sleep "$SHOT_WAIT"
    grim "$OUT" && echo "shot: $OUT"
    descendants() { for c in $(pgrep -P "$1"); do echo "$c"; descendants "$c"; done; }
    echo "memory (kB) of $(basename "$0") and its helpers:"
    total_rss=0; total_pss=0
    for p in $app $(descendants $app); do
      [ -r /proc/$p/smaps_rollup ] || continue
      name=$(tr "\0" " " < /proc/$p/cmdline | cut -c1-70)
      rss=$(awk "/^Rss:/ {print \$2}" /proc/$p/smaps_rollup)
      pss=$(awk "/^Pss:/ {print \$2}" /proc/$p/smaps_rollup)
      total_rss=$((total_rss + rss)); total_pss=$((total_pss + pss))
      printf "  pid %-7s rss %-9s pss %-9s %s\n" "$p" "$rss" "$pss" "$name"
    done
    printf "  total        rss %-9s pss %-9s\n" "$total_rss" "$total_pss"
    if [ -n "$SHOT_KEEP" ]; then
      echo "keeping the app until $OUT.done exists"
      while [ ! -e "$OUT.done" ]; do sleep 0.5; done
    fi
    kill $app 2>/dev/null; wait $app 2>/dev/null || true
  ' "$bin" "$@"
