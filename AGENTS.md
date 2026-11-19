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

Launch flags (all `--key=value`, for the paths on the same command line): `--page=N`, `--find=text`,
`--sidebar=pages|contents`, `--mode=continuous|single|two`, `--zoom=page-width|page-fit|1.5`,
`--night`, `--present`, `--fill=field=value` (PDF); `--toc`, `--flow=paged|scrolled`,
`--theme=auto|light|sepia|dark` (books); `--spread` (comics); `--source` (Markdown); `--sheet=N`
(spreadsheets); `--info`, `--slideshow`, `--zoom=200` (pictures). They are also how `scripts/shot.sh`
reaches every state headless.

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
