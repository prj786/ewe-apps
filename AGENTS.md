# ewe apps — map for agents

Three first-party apps of the ewe desktop in one repo and one Arch package: **ewe Files**
(`ewe-files-app`), **ewe Player** (`ewe-player`), **ewe Viewer** (`ewe-viewer`). Tauri 2 on the
system WebKitGTK, Solid + TypeScript + Vite in the window, Rust underneath, the UI ported from
ewe Browser. `docs/PLAN.md` is the plan and the status list; this file is how the repo works.
The workspace rules in `../AGENTS.md` apply (no raw colours/sizes/durations in CSS outside
`tokens.css` fallbacks; never edit `~/.config` or anything deployed; Arch only).

## Layout

```
package.json, pnpm-workspace.yaml   pnpm workspace: packages/*, apps/*  (run pnpm as npx -y pnpm@11.13.0)
Cargo.toml                          cargo workspace: crates/core, apps/*/src-tauri; one target/ for all
packages/shared  @ewe/shared        pure TS, tested with vitest: models (Point/Rect/Size/ThemeTokens),
                                    menu placement, files.ts (FsEntry, places, kinds, sort/filter,
                                    gvfsLabel, sync helpers), music.ts (albums/artists/search/shuffle),
                                    media.ts (rawUrl/thumbUrl/coverUrl), format.ts, requests.ts (the
                                    shapes the core returns: Launch, AppInfo, MimeInfo, …)
packages/ui      @ewe/ui            Solid kit: Icon (Lucide paths inline), Menu (+submenus, swatches),
                                    Switch, Segmented, EmptyState, Dialog, Toast(s), Tooltip, Slider,
                                    ProgressBar, Tabs, Toolbar/IconButton/Button, Field; styles/
                                    (tokens.css, base.css, components.css, fonts.css + Geist woff2);
                                    theme/ (parseEweTokens, applyTheme, followTheme); app/bridge.ts
                                    (getLaunch, onLaunch, getMediaServer, getAppVersion, addRecent)
crates/core      ewe-app-core       theme (read + notify watch), server (axum loopback media server),
                                    thumbs (freedesktop cache), cover (lofty + sidecar), recent
                                    (recently-used.xbel), mime (GIO), exif (kamadak-exif → ExifInfo),
                                    launch (argv), app (the Tauri builder; `run_with` takes a builder
                                    hook for app plugins), commands (the Tauri commands), xdg
apps/{files,player,viewer}          index.html, vite.config.ts (ports 5181/5182/5183), src/{index.tsx,
                                    App.tsx, app.css}; src-tauri/{Cargo.toml, tauri.conf.json,
                                    capabilities/default.json, icons/, src/lib.rs (SPEC + run)}
apps/files                          ewe Files: see the section "ewe Files" below
packaging/                          *.desktop (MimeType lists, StartupWMClass = binary), icons/*.svg
                                    + hicolor PNGs (scripts/gen-icons.sh)
PKGBUILD, .github/workflows/{ci,release}.yml, VERSION, LICENSE (GPL-3.0-only)
scripts/shot.sh                     headless launch + screenshot + memory (see Verify)
```

## Commands

```
npx -y pnpm@11.13.0 install
npx -y pnpm@11.13.0 typecheck            # tsc in every package
npx -y pnpm@11.13.0 lint                 # eslint flat config: typescript-eslint strict + eslint-plugin-solid
npx -y pnpm@11.13.0 format               # prettier (format:check in CI)
npx -y pnpm@11.13.0 test                 # vitest: packages/shared, packages/ui
npx -y pnpm@11.13.0 test                 # also apps/viewer: memory, csv, exif, flags
cargo test --workspace                   # the core's unit tests (Range, token, thumbnails, xbel, launch, mime, theme watch, exif) + the viewer's comics
cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
cd apps/viewer && npx -y pnpm@11.13.0 tauri dev                 # dev with HMR (same for files, player)
cd apps/viewer && npx -y pnpm@11.13.0 tauri build --no-bundle   # → target/release/ewe-viewer
target/release/ewe-viewer --version      # {"ok":true,"name":"ewe-viewer","product":"ewe Viewer","version":"0.1.1-beta"}
```

Build through the Tauri CLI, never bare `cargo build`, for anything you run: tauri-build decides
dev-vs-production at compile time and a plain cargo build bakes the Vite devUrl into the binary
(`cargo test` / `clippy` are fine). All three apps share `target/`, so the second and third
release builds take about a minute each.

## How the pieces talk

- **Start-up** (`crates/core/src/app.rs`, `ewe_app_core::run(SPEC, generate_context!(),
handler![…])`): `--version` prints JSON and exits 0 (rule 5); `glib::set_prgname(id)` before GTK
  starts so the Wayland app_id = binary name = `StartupWMClass`; `tauri-plugin-single-instance` —
  a second launch focuses the window and emits the `launch` event with its parsed argv; the media
  server and the theme watcher start; one window `main` (undecorated, Hyprland tiles) opens
  `index.html`; when it closes Tauri exits (nothing resident). Add app commands with
  `ewe_app_core::handler![my_cmd]` — it already lists the core's.
- **Launch args** (`launch.rs`, `getLaunch()` / `onLaunch()`): tokens starting with `--` are
  `flags` (use `--key=value`; a flag's value is never a separate token), everything else is a
  path (`file://` URLs decoded, relative paths joined to `cwd`, other URLs dropped). `--demo`
  opens the kit gallery in the placeholder apps.
- **Theme** (`theme.rs`, `packages/ui/src/theme/`): the core reads
  `$XDG_CONFIG_HOME/quickshell/theme-tokens.json` (v3) and watches the directory (ewe-theme
  renames a temp file into place), emitting `theme-changed` with the raw JSON. The webview maps it
  with `parseEweTokens` exactly like ewe Browser's `ewe-theme.ts`: colours (`#AARRGGBB` → rgba)
  and shadows into `vars`, shape/size (× `accessibility.text_scale`)/fonts/weights/motion
  (`÷ speed`, reduce motion → 1ms) into `base`; `applyTheme` sets them on `:root` and
  `data-theme` = the scheme variant. `followTheme()` in `index.tsx` does it before the first
  render. `tokens.css` holds the Ewe Dark/Light fallbacks (light-dark()) for when there is no file.
- **Media** (`server.rs`, `@ewe/shared` media.ts): `getMediaServer()` → `{port, token}`;
  `rawUrl(server, path)` = `http://127.0.0.1:<port>/raw/<name>?path=…&t=…` (single-range 206,
  `Accept-Ranges`, ETag/304, content types incl. mkv/opus/flac fixes), `thumbUrl(server, path,
128|256|512)` (freedesktop cache read/write, `image` crate with EXIF orientation,
  `ffmpegthumbnailer` for video, embedded cover for audio, 3 generations at once), `coverUrl`.
  Only regular files under absolute paths; 403 without the token; the CSP allows
  `http://127.0.0.1:*` for img/media/connect only. `EWE_APPS_MEDIA_SERVER_FILE=<path>` makes the
  app write `{port, token}` there (tests, curl).
- **Recent files** (`recent.rs`, `addRecent(path, mime?)`): parses `$XDG_DATA_HOME/
recently-used.xbel`, bumps or adds the entry with this app in `bookmark:applications`
  (`exec="'ewe-viewer %u'"`), prunes entries older than 30 days (GTK's default), writes atomically 0600. ewe Browser's Home and GTK dialogs read it.
- **Mime + apps** (`mime.rs`, commands `mime_of`, `apps_for {contentType, all?}`, `default_app`,
  `set_default_app {desktopId, contentType}`, `launch_with {desktopId|null, paths}`): GIO, on the
  main thread (GIO objects are not Send; these commands are sync).
- **Kit conventions** (from ewe Browser): every on/off is a `Switch`, 2–5 choices a `Segmented`,
  menus are data (`MenuEntry[]`) rendered by `Menu` at a `Point`, `EmptyState` for empty pages,
  `toast()` for short confirmations, `Dialog` for anything modal. `.page` is `surface-raised`,
  headers `.app-header`, `.toolbar` rows with `.toolbar-spacer`. No `text-transform: uppercase`.
  Icons: add Lucide paths to `Icon.tsx` (`ICONS`), stroke 2, 24-box.

## ewe Viewer (`apps/viewer`)

```
src/App.tsx                 tabs (Ctrl+T/O open, Ctrl+W close, Ctrl+Tab, Ctrl+1–9), start screen when none,
                            drag-and-drop (webview drag-drop event), single-instance `launch` → more tabs,
                            app menu (Open…, Open with…, Show in folder, About); every tab's view stays
                            mounted (hidden) so it keeps its place
src/views/PdfView.tsx       pdf.js viewer components (PDFViewer + EventBus + PDFLinkService +
                            PDFFindController, pdf_viewer.css imported and recoloured in app.css):
                            continuous / single / two pages, fit width / page / actual / zoom menu,
                            Ctrl+wheel + pinch, own thumbnails (lazy canvases) + outline sidebar, find bar
                            with highlights, forms (ENABLE_FORMS) + "Save a copy" (saveDocument → GTK save
                            dialog → save_bytes), rotate, presentation (window fullscreen, one page,
                            Esc), print (lib/print.ts renders every page to an image at 150 dpi into
                            #print-pages, then window.print()), password dialog (onPassword), night mode
                            (CSS invert), properties dialog, page + zoom + mode + rotation remembered
src/views/EpubView.tsx      <foliate-view> from src/vendor/foliate-js (MIT, see VENDORED.md): paged /
                            scrolled, contents, font size, auto / light / sepia / dark page colours
                            (renderer.setStyles), CFI remembered; keys inside the book iframe are re-sent
                            to the window
src/views/ComicView.tsx     pages from the core (comic_list / comic_page → blob URLs, ±6 cached), one page
                            or a spread (cover alone, right-to-left), fit page / width
src/views/TextView.tsx      ewe Browser's textview: highlight.js core + 24 languages, marked + DOMPurify,
                            relative images → raw URLs, first 2 MB, Source / Preview, wrap, text size
src/views/DocxView.tsx      docx-preview (pages, zoom, Ctrl+P prints the document itself)
src/views/SheetView.tsx     SheetJS for xlsx/xlsm/xls/ods (dense sheets), lib/csv.ts for csv/tsv; column
                            letters, frozen header row, one tab per sheet, first 5000 rows
src/views/ImageView.tsx     fit / actual / zoom at the cursor / drag, pinch (gesture events), rotate,
                            flip, slideshow, ←/→ through the folder (folder_images), info panel (stat +
                            EXIF rows from lib/exif.ts), copy (wl-copy), set as wallpaper (ewe-conf),
                            move to Trash (GIO), Open with…; HEIC says so plainly when WebKit can't
src/views/OtherView.tsx     ODT / PPTX / DOC…: type, size, GIO apps, "Open with the default app"
src/views/Start.tsx         recent documents from recently-used.xbel (recent_documents), thumbnails from
                            the core's cache for pictures and pdf.js' first page for PDFs
src/lib/{kinds,memory,csv,exif,flags}.ts   pure, unit-tested (vitest in apps/viewer)
src/lib/store.ts            positions.json under $XDG_DATA_HOME/ewe-viewer (store_read/store_write, debounced,
                            flushed on pagehide); small UI settings in localStorage
src/lib/pdfjs.ts            loads pdf.js once: worker bundled by Vite (?url), standard_fonts / cmaps / wasm /
                            iccs copied to dist/pdfjs by the plugin in vite.config.ts (dev middleware too)
src/lib/debug.ts            window errors, rejections, console.error/warn → `debug_log` → stderr
src-tauri/src/commands.rs   store_read/write, file_stat, folder_images, image_info (core exif), trash_file
                            (GIO), open_external (GIO, http/https/mailto only), set_wallpaper (what
                            nemo-actions' ewe-set-wallpaper.sh does), copy_image (wl-copy), save_bytes
                            (raw IPC body + `path` header), comic_list / comic_page (raw IPC response),
                            recent_documents, debug_log
src-tauri/src/comics.rs     natural order (tested), page filter, zip in-process; CBR/CB7 via bsdtar → 7z →
                            lsar/unar
```

The PDF toolbar condenses by its width: icon-only below 760 (the page modes become one button
with a menu, the zoom shows only its percent, "Save a copy" an icon), and below 560 Find and the
page modes move into ⋯. The image info panel takes at most half the window.

Launch flags (all `--key=value`, for the paths on the same command line): `--page=N`, `--find=text`,
`--sidebar=pages|contents`, `--mode=continuous|single|two`, `--zoom=page-width|page-fit|1.5`,
`--night`, `--present`, `--fill=field=value` (PDF); `--toc`, `--flow=paged|scrolled`,
`--theme=auto|light|sepia|dark` (books); `--spread` (comics); `--source` (Markdown); `--sheet=N`
(spreadsheets); `--info`, `--slideshow`, `--zoom=200` (pictures). They are also how `scripts/shot.sh`
reaches every state headless.

## ewe Files (`apps/files`, binary `ewe-files-app`)

Nemo and Engrampa's replacement, ewe Browser's files page grown into a window with tabs. The Rust
side is `apps/files/src-tauri/src/`, the page `apps/files/src/`.

```
src-tauri/src/lib.rs      SPEC, FilesState, every command (list_dir, places, devices_*, connect_server,
                          mount_reply, watch_dir, make_folder/file/link, rename_entry, templates, op_*,
                          ops_list, undo, trash_list, archive_*, search_*, stat_path, chmod_path,
                          folder_size_*, open_terminal, set_wallpaper, run_executable, komble_install,
                          ewe_sync, tools, clipboard_*, new_window, window_launch, dev_log); the
                          RunHooks: setup (state, GIO monitor, FileManager1), second_launch (new window,
                          or `launch` to the focused window with --tab)
  fs.rs                   list (lstat per row, writable, free), expand (~), unique_path "a (1).tar.gz",
                          mkdir, create_file (+ template copy), rename, create_link, templates, error words
  ops.rs                  the queue: one thread per job, Progress (bytes, items, speed, eta, state
                          queued|running|paused|waiting|done|failed|cancelled) emitted as `op-progress`
                          (120 ms throttle); pause/resume/cancel through a Condvar; name clashes ask
                          (`conflict` in the progress) and wait for op_resolve (replace / skip /
                          keep-both / cancel, once or for all); folder-over-folder replace = merge;
                          cross-device move = copy + remove; the undo journal (Move, Rename, RemoveTree
                          for copies, RemoveEmpty for new folders/files, Restore for trashed items),
                          50 deep, shared with the instant commands
  trash.rs                freedesktop Trash 1.0: home trash, `$top/.Trash/$uid` (sticky) or
                          `$top/.Trash-$uid` on other devices with relative Path=, .trashinfo created
                          O_EXCL (name, name.2, …), list across every trash, restore (unique name when
                          taken), delete forever, empty
  archive.rs              bsdtar -tvf / -xf / -a -cf; `lsar -j` + `unar` for RAR and what bsdtar
                          rejects; `7z a` for .7z; extract here = the archive's single top folder, or
                          a "<base>" folder, or "<root> (1)" through a temp dir when the folder exists
  search.rs               walkdir from the folder, filters (name/glob, kind, days, size, hidden),
                          batches of 40 as `search-results {id, window, items, done}`, 5000 max; a new
                          search stops the last; `plocate -i -l 500` for "everywhere"
  places.rs               ewe Browser's computePlaces in Rust (XDG dirs, ewe-files/ewe-drive status,
                          sync-folders.json, GTK bookmarks, /run/media, GVFS, rclone, File system,
                          Trash = `trash://`); tool_path ($EWE_BIN, ~/.local/share/ewe/bin, PATH)
  devices.rs              gio::VolumeMonitor (main thread; thread_local): volumes + volume-less mounts
                          as Device rows, `devices-changed`, mount/unmount/eject + "Connect to
                          server…" (mount_enclosing_volume) through a MountOperation whose ask-password
                          / ask-question become `mount-ask` / `mount-question`, answered by mount_reply;
                          results as `device-result {id, action, ok, path, error}`
  dbus.rs                 zbus: org.freedesktop.FileManager1 (ShowFolders / ShowItems /
                          ShowItemProperties → a new window with --folders / --select / --properties);
                          the name is simply not claimed while Nemo holds it
  props.rs                stat (owner/group names, mount, free/total), chmod, folder_size streamed as
                          `size-progress`
  clip.rs                 the GTK clipboard: x-special/gnome-copied-files + text/uri-list + text
  watch.rs                notify per pane key `<window>/<pane>`, 200 ms debounce, `fs-changed`
  misc.rs                 terminal (ewe-terminal-here, $TERMINAL, kitty…), set_wallpaper (what Nemo's
                          action ran: `ewe-conf set desktop.wallpapers.default "<json>"` +
                          hypr/scripts/wallpaper.sh --reapply), run_executable (setsid), komble, ewe-sync
src/App.tsx               the window: tabs (a Solid store), split view, places, menus (entry,
                          background, sort, place/device, tab), dialogs, the ops panel, quick look,
                          keys (Nemo's: F2, Del, Shift+Del, Ctrl+H/L/F/Shift+F, Alt+Up/Left/Right,
                          Backspace, Ctrl+1/2, Ctrl+=/-/0, Ctrl+Shift+N, F5, F3 split, F9 preview,
                          Space quick look, Ctrl+Z undo, Ctrl+T/W/N/Tab, Alt+Enter), drag and drop,
                          argv (`--select=`, `--open-with=`, `--properties`, `--tab`, archives,
                          folders, files), `--shot=<scene>` for scripts/shot.sh
src/pane.tsx              one folder view (toolbar, crumbs → path field, filter/type-ahead, grid/list,
                          windowed rows, status) in three modes: folder, trash (Original location /
                          Deleted columns), search results (Where column)
src/places.tsx            the places panel + devices; src/dialogs.tsx (conflict, properties with the
                          live size and a permissions editor, open with, connect, credentials, rename
                          many, compress, run, archive, path, confirm); src/ops-panel.tsx;
                          src/viewer.tsx + textview.tsx + pdfview.tsx (quick look); src/preview.tsx (F9);
                          src/search.tsx; src/prefs.ts (view/sort/hidden/zoom per app + per folder,
                          localStorage); src/api.ts (invoke + events)
```

- Thumbnails come from the core's `/thumb` (images, video, audio covers); PDFs are drawn by pdf.js
  in the page (`pdfThumb`, cached per url). The pdf.js worker module is imported into the main
  bundle: WebKitGTK refuses a module worker from `tauri://` ("Load failed") and pdf.js falls back
  to `globalThis.pdfjsWorker` when it is already there.
- Drag and drop: a drag sets `text/uri-list` (what other GTK apps take) plus
  `application/x-ewe-files`. Tauri's drag-drop handler returns true for any uri-list drop, which
  swallows the DOM `drop`, so drops are handled from `onDragDropEvent` by hit-testing
  `[data-drop]` under the pointer (DOM `dragover` still highlights, DOM `drop` is the fallback,
  deduped by time). Ctrl copies. Not exercised headless: see PLAN.md.
- Files open with the GIO default (`launch_with(null)`), archives in the archive dialog, programs
  and AppImages through the Run dialog (Komble install offered).
- `--shot=list|split|menu|copy|conflict|properties|openwith|archive|trash|quicklook|search|rename|preview|ops-preview|split-list|grid-preview|places|more|tabs|compress`
  puts a fresh window into that state (used for the screenshots); `--shot-width=900` /
  `--shot-height=600` size the app root like a smaller window inside cage's fixed 1280×720
  output (all three apps: `applyShotSize` in the kit; the root gets `contain: layout`, so
  dialogs and toasts stay inside it — menus still clamp to the 1280 viewport).
- **Window tiers** (the window's width: `winSize` in App.tsx; files.css has the same numbers as
  container queries on `app`, the container the kit makes of every `.app` root): wide ≥ 1100
  as designed; medium 760–1100 = places column 168px without its state chips, preview at most
  38 %; compact < 760 = places hidden, the places button opens it as a drawer over the pane
  (closes on a place, Esc or a click outside), F9 opens the preview as an overlay with a close
  button — both session-only, `prefs.places`/`prefs.preview` stay as saved — and Split, Preview,
  Operations, New window fold into a ⋯ menu; tiny < 480 = the tab strip scrolls, other tabs at
  96px. Everywhere: the open folder's tab keeps its name; F3 refuses ("Not enough room for two
  panes") when `.fm-main` < 2 × 300px, and a split tab that no longer fits shows its active
  pane only (`@container fm-main`).
- Narrow panes (split view, the preview pane): the pane is a CSS container; the list drops Type
  (< 760px), then Modified (< 560px), then Size (< 400px) and the name ellipsizes, never
  vanishes. The toolbar condenses by pane width (`tier`: wide ≥ 860, medium, narrow < 560):
  the filter becomes a button that expands in place of the crumbs, hidden/sort/view move into a
  ⋯ menu, and below 560 the crumbs collapse to "… › folder" (the … opens the parents) and New
  folder joins the menu. The Operations panel is a popover under its toolbar button (closes on
  a click outside), not a third column; a pane never goes under 300px. `dev_log` prints the webview's
  uncaught errors and unhandled rejections to stderr (`<out>.png.log` under shot.sh).
- Measured 2026-11-19 (release, headless cage): 3 pictures in a grid 236 MB PSS; a 3200-entry
  folder 238 MB PSS in the grid and 229 MB in the list (735 MB before the rows were windowed).

## ewe Player (`apps/player`)

```
src/App.tsx            mode (Video | Music, a Segmented in the header), opening paths/URLs/M3Us
                       (listMedia expands folders; all-audio → the music view, else the video queue
                       + folder siblings), dialogs (plugin-dialog), fullscreen + mini window ops,
                       MPRIS command routing to the active view's Transport, drag and drop, Ctrl+O/L
src/video/VideoPlayer.tsx  <video crossorigin> + the auto-hiding control bar (seek with buffered
                       ranges + hover time, ±10 s, frame step , . , speed [ ], volume 0–150 % via a
                       Web Audio gain above 100 %, subtitles: in-file textTracks + sidecars by name
                       as blob <track>s from `subtitle_vtt`, audioTracks picker, fit/fill/zoom/rotate,
                       F fullscreen, mini, S screenshot via ffmpeg, resume, codec errors in words)
src/video/Playlist.tsx queue (HTML5 drag to reorder, Delete) + "In this folder"
src/music/MusicView.tsx  ewe Browser's music page + Playlists (.m3u under the music root, open/save),
                       Queue view, Now playing page; AudioEngine (audio.ts) preloads the next track
src/start/StartScreen.tsx  recents (recent_media → our own recently-used.xbel entries) with resume marks
src/bridge.ts          the player's invoke wrappers + Transport; src/mpris.ts coalesces state pushes;
src/store.ts           localStorage `ewe.player.state` (mode, video prefs, music prefs, positions)
src-tauri/src/         library.rs (lofty scan, index JSON, incremental by mtime+size), subs.rs
                       (sidecars, SRT/ASS/SSA → VTT), playlist.rs (M3U), folder.rs, mpris.rs
                       (mpris-server, bus name org.mpris.MediaPlayer2.ewe-player), inhibit.rs
                       (org.freedesktop.ScreenSaver, hypridle honours it), probe.rs (ffprobe; 5 s
                       for a link), shots.rs (ffmpeg frame → ~/Pictures/Screenshots), recents.rs,
                       userdirs.rs, support.rs (`media_support`: gst-libav / yt-dlp / mpv, once),
                       links.rs (`resolve_link`: what a web link plays as; `open_in_browser`,
                       `open_in_mpv`)
packages/shared        player.ts (MediaItem with a link's title/thumbnail/duration, itemTitle,
                       decodeFailureMessage → PlayFailure {kind, actions}), links.ts (ResolvedLink,
                       MediaSupport, isDirectMediaUrl), languages.ts (ISO 639-1/2 → native names,
                       trackLabel, preferred-language rules)
```

- **argv**: files, folders, `.m3u`, `http(s)://` URLs (`Launch.urls`); `--enqueue` appends to the
  running instance instead of replacing; `--scene=<name>` is the screenshot hook (`controls`,
  `subs-menu`, `audio-menu`, `playlist`, `mini`, `music-albums`, `music-album`, `music-songs`,
  `music-now`, `music-playing`), `--shot-width=` as in Files. `ewe-player <page-url>` is the
  public way to play a web page (ewe Browser's "Play in ewe Player" and Shaun call it); a second
  launch forwards it to the running window. `$EWE_MUSIC_DIR` overrides the
  music root. Music scenes need `SHOT_WAIT=6` on a fresh home (the first scan).
- **Links** (`links.rs`, spike 2026-11-21 in the wave scratchpad `player/SPIKE.md`): a link
  whose path names media (`.mp4`, `.m3u8`, `.mpd`…) or that answers `video/*`, `audio/*`, an HLS
  or DASH type (curl, 6 s) plays as it is. Anything else goes to `yt-dlp -J --no-playlist
--flat-playlist` (60 s cap) and `pick()` chooses, in order: the **HLS master** `manifest_url`
  holding video + audio (YouTube's `hls_variant` with separate audio renditions plays through
  WebKit's legacy `hlsdemux`, seeks), one **progressive** file with both (Twitch clips, YouTube
  `18`; ≤ 1080 lines, mp4/H.264 first), a muxed HLS variant, a **DASH** `.mpd` (`dashdemux`; the
  BBC). Split https video + audio only → `unplayable` (the page offers mpv); `has_drm` → `drm`
  (Vimeo's anonymous player API serves FairPlay `SAMPLE-AES`; vimeo.com wants a login, other ids a
  TLS fingerprint python-curl_cffi would fake). A playlist page becomes queue entries. The webview
  resolves a link only when it becomes current ("Getting the video…"), caches it an hour, asks
  again once when a stream fails (googlevideo URLs expire after ~6 h). `EWE_PLAYER_YTDLP=<path>`
  runs another yt-dlp (one unpacked from the package for tests); a missing path = not installed.
  The Arch `yt-dlp` pulls `yt-dlp-ejs` + `deno` (YouTube's n-challenge); no remux route yet.
- **Errors** (`decodeFailureMessage` in `@ewe/shared`, pure + tested): a web page with no video,
  "needs yt-dlp", DRM, yt-dlp's own sentence ("Private video."), gst-libav _only when_
  `media_support` says it is missing (`EWE_PLAYER_LIBAV=0|1` forces the answer; hiding the
  plugin with `GST_PLUGIN_SYSTEM_PATH` makes it honest), else the codec in words and "refused".
  Actions: Open with another app (files), Open in ewe Browser (`ewe-browser <url>`, else
  xdg-open), Open in mpv (only when mpv is on PATH), Try again, Next.
- **Languages**: track menus say "English", "Русский · Commentary", "ქართული" (`trackLabel`; the
  title is dropped when it only repeats the language). `VideoPrefs.audioLanguage` (`auto` = the
  system's) and `subtitleLanguage` (`auto` / `off` / a code) live in `ewe.player.state`; the
  "Preferred language" submenus of the audio and subtitle menus set them. A file with several
  audio tracks gets the preferred one; subtitles come on by themselves only when the sound is in
  another language (or unknown), in the preferred language, else an untagged sidecar
  (`Movie.srt`). The system language is `navigator.language`, which WebKit takes from the
  _installed_ locale (`setlocale`): `LANG=de_DE.UTF-8` on a box without that locale reads as
  en-US — build one with `localedef -i de_DE -f UTF-8 <dir>/de_DE.UTF-8` and pass `LOCPATH=<dir>`
  (shot.sh passes it).
- **Narrow windows**: the music nav is a labelled column, an icon rail below 720 (labels as
  tooltips) and a segmented control over the list below 520 (Rescan moves into the ⋯ menu, the
  bar keeps the mute button only). The video bar below 560 (`narrowBar`, the stage's width, not
  in the mini window) hides the time, speed, picture and audio buttons; Speed and "Fit, zoom,
  rotate" join ⋯ as submenus.
- **MPRIS**: the webview is the source of truth; it pushes `mpris_update` (status, position every
  second, metadata with a `file://` art URL from `cover_art_file`, volume, loop, shuffle, rate) and
  the Rust `Player` answers the bus; method calls come back as the `mpris-command` event. Test
  against a private bus: `scripts/shot.sh` runs under `dbus-run-session`, so `playerctl -p
ewe-player status/position/metadata` inside it never touches the owner's session.
- **Idle**: `inhibit_idle(true)` while a video plays (D-Bus `org.freedesktop.ScreenSaver.Inhibit`,
  which hypridle serves because `ignore_dbus_inhibit = false`); released on pause and on exit.
- **Codecs** (matrix 2026-11-19, headless, `tools` in the session scratchpad; MPRIS position
  advancing 3 s per 3 s): without `gst-libav` the box plays H.264 (`vah264dec`), HEVC
  (`vah265dec`), VP9, AAC (faad), MP3, Opus, Vorbis, FLAC; MPEG-4 Part 2 (AVI) plays sound only
  (the player says so); WMV/WMA and ALAC fail with the plain-words page. With the extracted
  gst-libav all 26 rows play (`avdec_aac`, `avdec_wmv2`, `avdec_alac`…; VA decoders still win for
  H.264/HEVC). ewe 0.44 ships gst-libav.
- **Links** (2026-11-21, release build, headless, yt-dlp 2026.10.26 unpacked, MPRIS position read
  twice 3 s apart, then `playerctl position T`): YouTube `watch?v=` (HLS master, `avdec_aac` +
  `vah264dec`, 300 → 301.5), Twitch VOD (3000 → 3001.5) and clip, BBC News page (HLS), a direct
  CDN `.mp4` without CORS, an M3U of two page links, `ewe-player <url>` forwarded by a second
  launch — all advance. One YouTube start in nine stalled with no error (fragments never came):
  a link that has loaded nothing after 20 s is asked for again once, then gets the
  "connection broke" page (`STALL_MS`). Vimeo: no anonymous route (DRM / login).

## Verify (do this before reporting)

1. `typecheck`, `lint`, `format:check`, `test`, `cargo test --workspace`, `cargo clippy …`.
2. `tauri build --no-bundle` for the app you touched (all three when the core or the kit changed).
3. Launch headless and LOOK at the screenshot, dark and light:
   ```
   S=$(mktemp -d); for v in dark light; do mkdir -p $S/$v/quickshell;
     ../ewe/bin/ewe-theme build --conf /nonexistent --scheme ewe-$v --json $S/$v/quickshell/theme-tokens.json --css /dev/null; done
   scripts/shot.sh target/release/ewe-viewer $S/dark  /tmp/viewer-dark.png  --demo ~/some.pdf
   scripts/shot.sh target/release/ewe-viewer $S/light /tmp/viewer-light.png --demo
   ```
   `shot.sh` runs the binary inside `cage` (headless wlroots, pixman) under `dbus-run-session`,
   so nothing appears on the owner's screen and single-instance never reaches the live desktop;
   it prints the RSS/PSS of the app and its WebKit helpers. `SHOT_KEEP=1` keeps the app alive
   until `<out>.done` exists (curl the media server meanwhile, with
   `EWE_APPS_MEDIA_SERVER_FILE`).
4. Media server smoke: with the app kept alive, `curl -sI "http://127.0.0.1:$port/raw/x.mp4?path=$enc&t=$token" -H 'Range: bytes=0-99'` is `206` with `content-range`; without `t` it is `403`.

Measured 2026-11-19 (release build, placeholder page, headless cage): ewe Files = app 238 MB RSS /
112 MB PSS + WebKitWebProcess 230 / 81 + WebKitNetworkProcess 52 / 13 + bwrap/glycin ≈ 20 / 7 —
**about 540 MB RSS, 213 MB PSS in total** (RSS counts the shared GTK/WebKit libraries once per
process; PSS is the honest number). ewe Player placeholder: 516 MB RSS / 189 MB PSS; the real
player (2026-11-19): 1080p H.264 playing with controls ≈ 600 MB RSS / 284 MB PSS (app 107 +
WebProcess 150 + network 21 + glycin 7), music library idle ≈ 545 MB RSS / 234 MB PSS, music
playing ≈ 266 MB PSS.

## Gotchas already hit

- `tauri build` refuses an npm `@tauri-apps/api` whose major.minor differs from the `tauri`
  crate. The crate is `tauri = "2"` (resolves 2.12.x today) and every package.json pins
  `@tauri-apps/api ~2.12.5` / `@tauri-apps/cli ~2.12.6`; bump them together. Pinning `tauri =
"~2.11"` alone does NOT work: tauri-runtime floats to 2.12 and tauri 2.11 fails to compile
  against it.
- `#[tauri::command]` functions in the core are re-exported at the crate root (`pub use
commands::*` in lib.rs) because the macro it generates is `#[macro_export]`ed there;
  `generate_handler![ewe_app_core::commands::x]` would not resolve. Use `handler![…]`.
- GIO types are not `Send`: keep mime/app commands synchronous (they run on the main thread).
- Rust raw strings with `"#` inside need `r##"…"##` (a JSON colour literal bit us).
- vite `build.target` is `safari18`; WebKitGTK 2.54 is current Safari-class WebKit, no polyfills.
- The CSP has no `'unsafe-inline'` for scripts; Tauri adds hashes for its own. Styles allow
  `'unsafe-inline'` because Solid sets `style=` attributes.
- In cage the window is the whole 1280×720 output; the page must look right stretched.
- `shot.sh` cleanup: the document portal and gvfs mount fuse dirs inside the session runtime
  dir; it `fusermount3 -uz`'s them before `rm -rf`.
- eslint `projectService` needs every TS file in some tsconfig `include` (vite/vitest configs
  are listed explicitly).
- pnpm: `pnpm-workspace.yaml` `allowBuilds` whitelists esbuild and the Tauri CLI; a new
  dependency with a postinstall script needs adding there.
- **`fetch()` from the page needs CORS**: the webview is `tauri://localhost`, the media server
  `http://127.0.0.1`. `<img>`/`<video>` never cared, `fetch()` (text, PDFs, books, sheets)
  failed with a bare "Load failed" until `server.rs` reflected the app origins and answered the
  `Range` preflight. Vite dev origins (`http://localhost:518x`) are allowed too.
- **pdf.js viewer components read `globalThis.pdfjsLib` at import time** — import
  `pdfjs-dist` first, then `pdfjs-dist/web/pdf_viewer.mjs` (`lib/pdfjs.ts` does; in parallel
  it dies with "Cannot destructure property 'AbortException'"). The viewer `container` must be
  `position: absolute` (pdf.js throws otherwise). `pdf_viewer.css` defines `.dialog` and
  `.page`, the same names as the kit: it is imported before `app.css` and `.pdfViewer .page`
  gets `display: block` back.
- **Never replace a tab's object to change its label**: `<For>` keys by identity, the view
  remounts, and a view that reports its title (PDF metadata, a book's title) remounts forever
  (RAM climbs, pdf.js logs "Transport destroyed"). Titles live in a separate signal map.
- `foliate-view`'s `renderer` exists only after `open()`; theme changes before that must not
  touch it. Keys typed inside the book iframe never reach the window: the `load` event's
  `doc` gets a keydown relay.
- Tauri IPC returns raw bytes with `tauri::ipc::Response::new(bytes)` (comic pages) and takes
  them with `tauri::ipc::Request` + `InvokeBody::Raw` (save_bytes, path in a header).
- The agents' scratchpad is shared between the parallel app agents: write into a per-app
  subfolder (`scratchpad/viewer/…`) or the other agent's screenshots get overwritten.
- `scripts/shot.sh` uses the real `$HOME` unless you export another one: the apps then write
  the owner's `recently-used.xbel` and `~/.local/share/<app>/`. Run it with
  `HOME=<tmp> scripts/shot.sh …` for fixtures.

- notify's inotify mask includes `OPEN`: a folder watch fires on our own `read_dir`, and a
  reload-on-change loop follows. `watch.rs` drops `EventKind::Access(_)`.
- `<For each={tabs()}>` with a signal of fresh objects rebuilt every pane on a title change
  (which reloaded, which set the title…). Tabs are a Solid store; only the changed field moves.
- The media server's CORS layer (`cors` in server.rs) reflects the apps' own origins only
  (`tauri://localhost`, `http://tauri.localhost`, the Vite dev ports) with Range allowed and
  Content-Range exposed, OPTIONS answered; no `*` anywhere (a `<video crossorigin>` sends the
  page's origin too). `fetch()`, pdf.js and Web Audio need it; `<img>` never did.
- `run_with(RunHooks)` / `open_window` in the core are additive; `run()` is unchanged. A second
  window needs its label in the capability's `windows` (`win-*`).

- ewe Player: WebKitGTK publishes its **own** MPRIS player for any page that plays media
  (`org.mpris.MediaPlayer2.org.webkit.app-<hash>.Sandboxed.instance-N`, owned by the
  WebKitWebProcess). The `MediaSession` / `MediaSessionManagerInUIProcess` runtime features do
  not stop it and only the owner can release a bus name, so it stays; the shell's now-playing
  has to skip `org.webkit.*` players (ewe repo), ours is `org.mpris.MediaPlayer2.ewe-player`.
- A Tauri event emitted before the webview called `listen()` is lost: a fast library scan
  finished before the music page subscribed and the page said "Scanning…" forever. Subscribe
  first (`await listen(...)`), then invoke the command that starts the work.
- `tauri::Builder::setup` replaces the previous hook, and the core registers its own — an
  app's start-up goes in a plugin (`tauri::plugin::Builder::new("…").setup(…)`) handed to
  `ewe_app_core::run_with`.
- `HTMLMediaElement.audioTracks` is a WebKit extra: not in lib.dom (declare a small
  interface) and not iterable (index loop, eslint `prefer-for-of` disabled on that line).
- `@tauri-apps/plugin-dialog` option objects do not accept `defaultPath: undefined` under
  `exactOptionalPropertyTypes`; spread `{ defaultPath }` only when known.
- lofty 0.22: `Tag::get_string(&ItemKey::X)` takes a reference; lofty reads no ASF/WMA tags
  (WMA shows up as "Unknown album" with the file name as title).
- **WebKit's media download buffer** (`GST_PLAY_FLAG_DOWNLOAD` → GStreamer `downloadbuffer`,
  100 KB / 5 s by default) estimates buffered time from the download rate; fed from the
  loopback server at ~100 MB/s it reports "5 % buffered" and WebKit parks the pipeline in
  PAUSED — 5–20 MB videos with audio never started, audio-only and sub-MB files did. ewe Player
  sets `WPE_SHELL_MEDIA_DISK_CACHE_SIZE_BYTES=512 MiB` / `_NSEC=600 s` in its own environment
  before WebKit starts (`webkit_media_env()` in lib.rs); any app that plays long media through
  the server needs the same. `WEBKIT_GST_ENABLE_HLS_SUPPORT=1` is needed for `.m3u8` URLs.
  `GST_DEBUG=webkitmediaplayer:6,downloadbuffer:5` is how to see it.
- **A `crossorigin` `<video>` cannot play links**: the CDNs (googlevideo, Twitch, BBC…) send no
  `Access-Control-Allow-Origin`, so every remote load failed as "format not supported" — the
  owner's "Cannot play watch" page. Only the loopback server's files get `crossorigin`; links stay
  at ≤ 100 % volume (Web Audio plays a cross-origin source as silence), and a link that follows a
  boosted file gets a fresh `<video>` (once captured by `createMediaElementSource` an element
  only plays through the graph).
- **WebKit's automatic caption selection** flips a track we set to `showing` back off when more
  tracks arrive (in-band tracks after the sidecars): auto-picked subtitles never drew. The
  textTracks `change` event re-applies our choice (`applySubs` writes only real changes).
- Subtitles at the bottom sat under the control bar: `video::-webkit-media-text-track-container`
  takes a `transform` in WebKitGTK and inherits custom properties from `.vp`, so
  `--vp-cue-lift` (bar height + a margin, 0 when `controls-hidden`) slides the cue line up and
  down with a transition. `cue.line` would jump and re-lay every cue.
- A server that answers headers and then never sends a byte froze the whole WebProcess (no
  paint, no JS) in a test; one that never answers at all is caught by the stall watchdog.
- Headless cage has no audio server: GStreamer falls back to a fake sink, audio files still
  play and advance (good for the matrix) but nothing is audible. VA-API decoding works there
  (`GST_DEBUG=GST_ELEMENT_FACTORY:4` shows `vah264dec` / `vah265dec` being created).
- ffmpeg's `gradients` filter writes semi-transparent RGBA PNGs; a test cover that "does not
  show" may just be 35 % opaque — generate covers with `-pix_fmt rgb24`.
