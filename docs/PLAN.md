# ewe apps — plan (2026-11-19)

Owner's ask (2026-11-19): "remove bloated stuff from packages … create same ui and visuals but
more feature rich apps, same we have in ewe-browser already: file manager instead of nemo, video
and audio player instead of the things we have now … missing multimedia codecs … pdf and document
viewer similar to ewe-browser … same feeling, same styling, ewe design system … ISO is over 3.2 GB
… idle RAM usage is huge … familiar design for all new apps … plan first, implement after so I
can run pacman update after that."

This repo holds the three new first-party apps. The same wave also slims the `ewe` package, the
ISO and idle RAM in the other repos (section "The rest of the wave").

## Decisions

- **Tauri 2 + Solid + TypeScript + Vite, Rust backend** — one repo, three apps. Tauri because the
  owner asked for "new Tauri apps" (2026-11-19) and because the system WebKitGTK is shared (no
  extra Chromium per app, ~60–120 MB per open app, nothing resident), its `<video>`/`<audio>` go
  through GStreamer (every codec once `gst-libav` is in, VA-API hardware decoding through
  `gst-plugin-va`), and every app gets its own window class and desktop entry. Solid because the
  owner wants the UI of ewe Browser: its files page, viewer, text view, archive dialog, music page,
  `Icon`, `Menu`, `Switch`, `Segmented`, `EmptyState` and its CSS (`tokens.css`, `base.css`,
  `components.css`, `fonts.css`) are ported, not redrawn.
- **Reverses** the old "first-party apps are traditional GTK (Nemo, Engrampa, imv, Zathura, mpv)"
  decision for these roles. The vault gets a new decision at release.
- Names ("ewe + Word"): **ewe Files** (binary `ewe-files-app` — `ewe-files` is already the
  Nextcloud mount broker CLI, a public contract; precedent `ewe-safe-app`), **ewe Player**
  (`ewe-player`), **ewe Viewer** (`ewe-viewer`). App ids / window classes = the binary names.
- One pacman package **`ewe-apps`** with the three binaries, desktop entries, icons; built by
  `.github/workflows/release.yml` on a `v*` tag exactly like ewe-sync (makepkg in
  `archlinux:base-devel`, `_tag`/`pkgver` rewritten, asset on the GitHub release), picked up by
  ewe-repo's publish workflow. `ewe` depends on it.
- Nothing resident: each app quits when its last window closes. No tray, no autostart.
- Look: Ewe design system v3 tokens only (no raw colours/sizes/durations in CSS outside
  `tokens.css` fallbacks), Geist / Geist Mono, light + dark, follows the live ewe theme (accent,
  scheme, text size, reduce motion) like ewe Browser does (`~/.config/quickshell/theme-tokens.json`
  v3 → CSS vars, watched). No window controls (Hyprland tiles). Keyboard first. Every on/off a
  Switch, 2–5 choices a Segmented. Plain words (owner wants simple wording).
- Every CLI entry prints JSON and exits 0 (rule 5) — the apps' only CLI surface is `--version`,
  `--json-status` style flags if any; opening paths is plain argv.

## Layout

```
package.json, pnpm-workspace.yaml      workspace: packages/*, apps/*
Cargo.toml                             cargo workspace: crates/core, apps/*/src-tauri
packages/ui/                           @ewe/ui — Solid kit ported from ewe-browser (Icon, Menu,
                                       Switch, Segmented, EmptyState, Dialog, Toast, Tooltip,
                                       Slider, ProgressBar, Tabs), styles (tokens, base,
                                       components, fonts + Geist woff2), theme follower
                                       (applyTheme from the tokens JSON), format helpers
packages/shared/                       @ewe/shared — files.ts / music.ts helpers ported from
                                       ewe-browser + the apps' request types
crates/core/                           ewe-app-core — theme tokens (read + watch), the local media
                                       server (127.0.0.1, random port, per-run token, Range,
                                       raw / thumb / cover routes), thumbnails (freedesktop cache
                                       read/write, image crate, ffmpegthumbnailer, covers via
                                       lofty), recent files (GTK recently-used.xbel write so Home
                                       and other apps see them), mime + GIO app lookup, open-with
apps/files/   (ewe Files,  ewe-files-app)
apps/player/  (ewe Player, ewe-player)
apps/viewer/  (ewe Viewer, ewe-viewer)
packaging/                             desktop entries, SVG icons + PNGs, mime list
PKGBUILD, .github/workflows/{ci,release}.yml
```

Raw files reach the webview through the core's loopback server (`http://127.0.0.1:<port>/raw/
<name>?path=…&t=<token>`), never `file://` and never a whole-file custom-scheme response
(WebKitGTK media needs real Range streaming). CSP allows `media-src`/`img-src` for that origin only.

## ewe Files (replaces Nemo and Engrampa)

Start from ewe Browser's `pages/files` (places panel, toolbar with crumbs → path field, filter /
type-ahead, grid + list, sort, hidden, status line, context menus, keys, viewer, archive dialog,
sync glyphs + "Keep in your account…"), then add:

- Tabs (Ctrl+T, Ctrl+W, Ctrl+Tab, middle-click a folder), split view (F3), new window (Ctrl+N).
- Operations in Rust with a progress panel: copy / move / trash / delete with bytes, speed, time
  left, pause, cancel; conflict dialog (Replace / Skip / Keep both, "do this for all"); Undo
  (Ctrl+Z) for rename, move, trash, new folder.
- Trash place with Restore, Delete forever, Empty Trash (freedesktop trash spec, `trash` crate).
- Devices and network through GIO (gtk-rs `gio`, already linked by Tauri): USB drives, phones
  (MTP), SD cards, optical; mount, unmount, eject / safely remove; "Connect to server…"
  (smb://, sftp://, ftp://, davs://) with credentials via GIO's mount operation; GVFS mounts.
- Properties: type, size (folders counted live), contents count, location, dates, permissions
  editor, "Open with" default for this type.
- Open with…: apps for the type from GIO, "Always use for this type" (`set_as_default_for_type`),
  "Other app…" (search all apps).
- New folder, New file (empty + ~/Templates), Create link, Copy path, Open in Terminal
  (`ewe-terminal-here`), Set as wallpaper (`ewe-conf`), Run executable / AppImage asks first.
- Batch rename (F2 on many): find/replace, numbering, case.
- Search: recursive from the current folder, streamed results, filters (type, modified, size);
  "Search everywhere" through `plocate` when present.
- Quick look (Space) with the viewer; optional preview pane (F9).
- Drag and drop: inside the app, between windows, files dropped from other apps, drag out to
  other apps (tauri-plugin-drag or GTK drag source).
- Archives: list / extract here / extract to… / compress (zip, tar.gz, tar.zst, 7z) through
  `bsdtar` and `7z`; RAR through `unar` when bsdtar can't. Opening an archive shows its contents
  in the archive dialog (no Engrampa).
- Thumbnails for images, videos, PDFs (first page, pdf.js), audio covers, fonts optional.
- `org.freedesktop.FileManager1` on the session bus (ShowFolders, ShowItems,
  ShowItemProperties) so every app's "Show in folder" lands here; `--select <path>` argv.
- Single instance: a second launch opens a new window (or tab with `--tab`) in the running app.

## ewe Player (replaces mpv as the video app and is the music app)

- Video: `<video>` on WebKitGTK/GStreamer. Auto-hiding control bar in Ewe style: play/pause,
  seek bar (buffered, hover time), ±10 s, frame step (, .), speed (0.25–3×), volume (0–150 %
  through Web Audio gain), mute, subtitles (embedded text tracks; `.srt .vtt .ass .ssa` next to
  the file loaded by name, "Load subtitles…"; SRT/ASS converted to VTT in Rust; size and position
  settings), audio track picker, fit / fill / zoom, rotate, fullscreen (F, double-click),
  always-on-top mini player, playlist panel (folder siblings + queue, drag to reorder), resume
  where you left off, screenshot of the frame (→ ~/Pictures/Screenshots), open file / folder /
  URL (http(s), HLS), drag and drop, a start screen with recent videos.
- Music: port ewe Browser's `pages/music` (Albums / Artists / Songs, album pages, search, queue,
  shuffle, repeat, volume); library from XDG_MUSIC_DIR scanned in Rust (lofty tags + covers,
  index JSON in `$XDG_CACHE_HOME/ewe-player`); playlists (M3U save/load); preload the next track.
- MPRIS on the session bus from Rust (mpris-server crate): the dock's now-playing and the media
  keys drive it. Inhibit idle while a video plays (D-Bus `org.freedesktop.ScreenSaver` Inhibit
  or the portal).
- Keys: Space/K, ←/→ 5 s, J/L 10 s, ↑/↓ volume, M, F, C subtitles, [ ] speed, N/P next/prev, Esc.
- If GStreamer cannot decode a file, say which codec is missing in plain words — and blame
  gst-libav only when it really is missing (`media_support`); a web page is called a web page.
- Links to pages (YouTube, Twitch, news sites…): yt-dlp finds the stream, the HLS master /
  progressive file / DASH manifest plays in WebKit; title, picture and length in the queue,
  header and MPRIS; "Open in ewe Browser" / "Open in mpv" when it cannot.
- Audio and subtitle tracks in their own words ("Русский", "ქართული"); preferred audio and
  subtitle language (default the system's), picked when a file has several.

## ewe Viewer (replaces Zathura and imv)

- PDF with pdf.js (`pdfjs-dist` viewer components): continuous / single / two-page, fit width /
  fit page / actual size / zoom, thumbnails sidebar, outline, find with highlights, text
  selection + copy, links, form filling, annotations shown, rotate, presentation mode, print
  (GTK print dialog via `window.print()`), password prompt, night mode (inverted pages),
  document properties, remembers page and zoom per file.
- EPUB with foliate-js (paged / scrolled, contents, font size, light/dark/sepia), comics (CBZ,
  CBR via the core), Markdown / text / code (port ewe Browser's `textview.tsx`: highlight.js,
  marked + DOMPurify), DOCX (docx-preview), XLSX / ODS / CSV (SheetJS, read-only grid). Formats
  it cannot show (ODT, PPTX, DOC) get a clear page with "Open with…".
- Images: fit / actual size, zoom and pan (wheel, pinch, drag), rotate, flip, slideshow, step
  through the folder (←/→), info (size, dimensions, EXIF date/camera), copy, set as wallpaper,
  move to Trash. GIF/WebP/AVIF/SVG animate.
- Tabs for several documents in one window; a start screen with recent documents.

## The rest of the wave (other repos)

- **ewe** (branch `fix/small-things`): `packages/common.list` drops nemo, engrampa, imv,
  zathura, zathura-pdf-mupdf, tesseract-data-eng (+ its PKGBUILD pin), mpv (stays installed as
  mpvpaper's dependency), mpv-mpris, ttf-jetbrains-mono-nerd (unused since Geist Mono), qt5-wayland
  (no Qt5 app ships), kdeconnect and gnome-network-displays (the Phone / Cast plugins already
  `require` them; Komble installs missing packages first), base-devel (Komble installs it before
  the first AUR build); adds gst-libav, gst-plugins-base/good/ugly, ffmpeg explicitly, ewe-apps.
  `aur.list` drops mpv-uosc-git. Mime defaults (`ewe-setup`, phase 60) point folders, archives,
  images, PDFs/documents, video and audio at the new apps; `hyprland.lua` fileManager, Launcher
  "Open containing folder", warmup list, nemo seeding follow.
- **ewe-repo**: reversal-icon-theme pkgrel 2 — the 22 colour variants keep only their differing
  files (285 of ~10,660) and symlink the rest to `Reversal` / `Reversal-dark` (416 MB → ~80 MB
  installed, 1.9 GB → ~0.2 GB on disk); publish.yml learns `ewe-apps`; aur-packages.txt drops
  mpv-uosc-git.
- **nvidia-utils on every machine** (found 2026-11-19): zed needs the `vulkan-driver` virtual and
  the installer runs `pacman -S ewe` BEFORE it adds the per-vendor GPU driver, so pacman picked
  nvidia-utils (1 GB, blacklists nouveau) on Intel and AMD machines too — the owner's Intel-only
  laptop has it. Fix: `vulkan-swrast` (Mesa CPU Vulkan, 14 MiB) is front-pinned in the ewe
  PKGBUILD, listed in common.list and in the ISO list; ewe-repo's fresh-install gate blacklists
  nvidia-utils.
- **ewe-os** (branch `fix/password-sign-in`): nvidia-open leaves the ISO (it only rode along
  because nvidia-utils had blacklisted nouveau) — nouveau drives NVIDIA in the live session, the
  installed system still gets NVIDIA's driver in the layer step; cloud-init (+ its unit links),
  clonezilla and its imaging tools, irssi, lynx, mc, nmap, tcpdump, refind, dial-up/VPN extras
  go (archinstall, brltty/espeakup for the accessibility boot entry, VM guest tools stay).
  Measured package sum: 7.5 GB → 5.4 GB installed, 2.48 → 1.90 GB compressed (≈ 3.2 GB → ~2.4 GB
  ISO). Tag only when the owner asks.
- **Idle RAM** (measured 2026-11-19 on the owner's box): `komble --updates` and `ewe-sync
--hidden` each keep a hidden WebKit page (~190 MB each) — create the window on demand and
  destroy it on close, keep the Rust side resident; the shell (`qs`, 306 MB, 240 MB anon) gets
  an audit for surfaces and images that are built before they are needed. ewe Browser's resident
  process is ~115 MB without windows (not a target).

## Release order

ewe-apps 0.1.0-beta (new repo prj786/ewe-apps) → Komble, ewe-sync, ewe-settings, ewe Browser
(owner reviews the staged browser diff first) → ewe 0.44.0-beta (depends on ewe-apps) → ewe-repo
publish → owner runs `pacman -Syu`. Old apps stay installed as orphans after the upgrade;
`sudo pacman -Rns nemo engrampa imv zathura zathura-pdf-mupdf mpv-mpris mpv-uosc-git` removes them.

## Status

- [x] scaffold (workspace, @ewe/ui, @ewe/shared, ewe-app-core, three apps that open themed) — 2026-11-19
- [x] ewe Files — 2026-11-19, branch `feat/files` (everything in the list above; see AGENTS.md
      "ewe Files" for the map and what is still unproven: drag-out to other apps and drops from
      other apps were built on WebKitGTK's uri-list drag and Tauri's drag-drop events but could
      not be exercised headless; MTP phones, SMB/SFTP credentials and eject ran only against the
      GIO API, not real devices)
- [x] ewe Viewer — 2026-11-19, branch `feat/viewer`: every format in the list above opens (PDF via
      pdf.js components with forms/find/outline/presentation/print/password/night, EPUB via
      foliate-js, CBZ/CBR, Markdown/text/code, DOCX, XLSX/ODS/CSV, pictures with EXIF/wallpaper/
      Trash, Open with… for the rest), tabs + start screen + drag-drop + single instance,
      `--key=value` flags for every state; screenshots dark + light in the agents' map. Not done:
      annotations are shown but not editable; HEIC depended on the system's glycin loader (since
      2026-11-21 the core converts it); print
      and the GTK dialogs could not be exercised headless (owner's real-machine list in the report).

- [x] ewe Player — 2026-11-19 (branch `feat/player`): video player (GStreamer `<video>`, Ewe control
      bar, subtitles in-file + sidecar SRT/ASS/VTT, audio tracks, speed, 150 % volume, fit/rotate,
      fullscreen, mini, playlist panel, resume, screenshots, URL/HLS, drag and drop, start screen with
      recents), music (Browser's page + M3U playlists, queue, now-playing, next-track preload, Rust
      lofty scan), MPRIS `org.mpris.MediaPlayer2.ewe-player`, idle inhibit, codec errors in words.
      Open: real-machine check (Hyprland float rule for the mini window, media keys through the dock,
      VA-API on the owner's GPU), gst-libav lands with ewe 0.44.
- [x] ewe Player links + honest errors + track languages — 2026-11-21 (branch `feat/player-links`,
      wave A1/A2/A6): `media_support` (gst-libav / yt-dlp / mpv), `resolve_link` (yt-dlp `-J` →
      HLS master, progressive, DASH; playlists expand into the queue), the error page says "web
      page" / "locked (DRM)" / "needs gst-libav" (only when missing) / codec in words, with Open in
      ewe Browser / Open in mpv / Try again; links play without `crossorigin` (CDNs send no CORS);
      track menus in native names + preferred languages; bottom subtitles ride above the visible
      control bar. Spike results in AGENTS.md "Links". Not done: the ffmpeg remux route for sites
      that only offer separate video + audio files (none of the tested ones); Vimeo serves DRM or
      blocks anonymous clients; drops of links from a browser were not exercised headless.
- [x] text in any encoding, phone pictures, right-to-left names — 2026-11-21 (branch
      `feat/text-images`, wave "media + languages" L3/A4/L4): the core decodes text with
      chardetng + encoding_rs (BOM, UTF-8, else a guess helped by the file name's language or the
      system's) for the Player's subtitles and `.m3u` titles, the Viewer's text view / Markdown /
      CSV and Files' quick look + preview; Encoding menus in the Viewer's text toolbar and the
      Player's subtitle menu. HEIC/HEIF become a cached upright JPEG through `heif-dec` (Viewer,
      quick look, preview); HEIC/AVIF/JPEG XL thumbnails; AVIF/JXL show natively. Names, titles
      and tags carry `dir="auto"`; Noto script faces precede `system-ui` (Arabic was drawn in
      FreeMono, unjoined). Not done: ID3v1/Latin-1-frame tags in cp1251 still read as Latin-1
      (lofty); copying or setting a HEIC as wallpaper uses the original file.
- [x] packaging + CI + release workflow — 2026-11-19 (desktop entries, icons, PKGBUILD, ci.yml, release.yml; the GitHub repo and the first tag are the owner's call)
- [x] ewe package diet, mime defaults, shell references (+ Settings → Default apps rows)
- [x] ewe-repo (Reversal dedupe via hardlink, publish ewe-apps, gate blacklists nvidia-utils)
- [x] ISO trim
- [x] idle RAM (Komble quits on close, ewe-sync's window only while shown, shell −22…24 MB)
- [x] the phone in ewe Files — 2026-11-26 (0.5.0-beta; ewe RFC-012, A1): a phone paired over
      KDE Connect is a device row (Connect / away / eject), mounted through the daemon's sshfs,
      and reads as a place ("Pixel › DCIM"). `apps/files/src-tauri/src/phones.rs`,
      `scripts/test-phones.sh`. Mounted, listed and unmounted for real against a Pixel; the
      window itself was driven against a stand-in daemon under a headless cage
- [x] small windows, true drops — 2026-11-27 (0.5.1-beta): no minimum window size (a tile
      smaller than the minimum was drawn squeezed or cropped and the pointer missed what it
      showed); hover ends when the pointer leaves the window; a panic is written to the journal;
      a drop in ewe Files lands on the folder under the pointer at any scale (at scale 2 it
      went to the row at half the coordinates); hints are one bubble inside the window; the
      three apps hold together down to about 240 × 200. Driven with a virtual pointer in a
      nested Hyprland at scale 1 and 2. Not fixed: the drag picture is twice too large at
      scale 2 (WebKitGTK, AGENTS.md "Gotchas")
- [ ] vault
