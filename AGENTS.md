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
                                    (recently-used.xbel), mime (GIO), launch (argv), app (the Tauri
                                    builder), commands (the Tauri commands), xdg
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
cargo test --workspace                   # the core's unit tests (Range, token, thumbnails, xbel, launch, mime, theme watch)
cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
cd apps/viewer && npx -y pnpm@11.13.0 tauri dev                 # dev with HMR (same for files, player)
cd apps/viewer && npx -y pnpm@11.13.0 tauri build --no-bundle   # → target/release/ewe-viewer
target/release/ewe-viewer --version      # {"ok":true,"name":"ewe-viewer","product":"ewe Viewer","version":"0.1.0-beta"}
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
- `--shot=list|split|menu|copy|conflict|properties|openwith|archive|trash|quicklook|search|rename|preview|ops-preview|split-list|grid-preview`
  puts a fresh window into that state (used for the screenshots); `--shot-width=900` narrows the
  app root to check a small window inside cage's fixed 1280×720 output.
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
process; PSS is the honest number). ewe Player: 516 MB RSS / 189 MB PSS.

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
- notify's inotify mask includes `OPEN`: a folder watch fires on our own `read_dir`, and a
  reload-on-change loop follows. `watch.rs` drops `EventKind::Access(_)`.
- `<For each={tabs()}>` with a signal of fresh objects rebuilt every pane on a title change
  (which reloaded, which set the title…). Tabs are a Solid store; only the changed field moves.
- The media server sends CORS headers (`*`, Range allowed, Content-Range exposed, OPTIONS 204):
  the page's origin is `tauri://localhost`, so `fetch()` and pdf.js need them; `<img>` never did.
- `run_with(RunHooks)` / `open_window` in the core are additive; `run()` is unchanged. A second
  window needs its label in the capability's `windows` (`win-*`).
