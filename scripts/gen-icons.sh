#!/usr/bin/env bash
# PNGs from the SVG app icons: hicolor sizes for the package, and the four files
# tauri-build expects in each app's src-tauri/icons (icon.png is the window icon).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v rsvg-convert >/dev/null || { echo "rsvg-convert (librsvg) is needed" >&2; exit 1; }
declare -A dir=([ewe-files-app]=files [ewe-player]=player [ewe-viewer]=viewer)
for id in ewe-files-app ewe-player ewe-viewer; do
  svg="packaging/icons/$id.svg"
  for s in 32 48 64 128 256 512; do
    out="packaging/icons/hicolor/${s}x${s}/apps"
    mkdir -p "$out"
    rsvg-convert -w "$s" -h "$s" "$svg" -o "$out/$id.png"
  done
  t="apps/${dir[$id]}/src-tauri/icons"
  mkdir -p "$t"
  cp "packaging/icons/hicolor/32x32/apps/$id.png" "$t/32x32.png"
  cp "packaging/icons/hicolor/128x128/apps/$id.png" "$t/128x128.png"
  cp "packaging/icons/hicolor/256x256/apps/$id.png" "$t/128x128@2x.png"
  cp "packaging/icons/hicolor/512x512/apps/$id.png" "$t/icon.png"
done
echo "icons written"
