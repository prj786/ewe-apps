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
                                    media.ts (rawUrl/thumbUrl/coverUrl/pictureUrl), text.ts (textUrl,
                                    readText, TEXT_ENCODINGS + their words), format.ts, requests.ts (the
                                    shapes the core returns: Launch, AppInfo, MimeInfo, …)
packages/ui      @ewe/ui            Solid kit: Icon (Lucide paths inline), Menu (+submenus, swatches),
                                    Switch, Segmented, EmptyState, Dialog, Toast(s), Tooltip, Slider,
                                    ProgressBar, Tabs, Toolbar/IconButton/Button, Field, OpenWith +
                                    AppRows (the design system's "Open with" card); styles/
                                    (tokens.css, base.css, components.css, fonts.css + Geist woff2);
                                    theme/ (parseEweTokens, applyTheme, followTheme); app/bridge.ts
                                    (boot, getLaunch, onLaunch, getMediaServer, getAppVersion, addRecent,
                                    trace), app/fonts.ts (fontsReady)
crates/core      ewe-app-core       theme (read + notify watch), server (axum loopback media server),
                                    thumbs (freedesktop cache), text (any encoding → UTF-8: BOM, UTF-8,
                                    chardetng + encoding_rs), picture (HEIC → cached JPEG; HEIC/AVIF/
                                    JXL decoded for thumbnails), cover (lofty + sidecar), recent
                                    (recently-used.xbel), mime (GIO), exif (kamadak-exif → ExifInfo),
                                    eep (eep app cards: name + embedded icon, cached per path+mtime),
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
scripts/perf.sh                     headless launches with EWE_APPS_TRACE=1: every start-up mark in ms
                                    since the launch, several runs and the median (see "Start-up")
```

## Commands

```
npx -y pnpm@11.13.0 install
npx -y pnpm@11.13.0 typecheck            # tsc in every package
npx -y pnpm@11.13.0 lint                 # eslint flat config: typescript-eslint strict + eslint-plugin-solid
npx -y pnpm@11.13.0 format               # prettier (format:check in CI)
npx -y pnpm@11.13.0 test                 # vitest: packages/shared, packages/ui
npx -y pnpm@11.13.0 test                 # also apps/viewer: memory, csv, exif, flags
cargo test --workspace                   # the core's unit tests (Range, token, thumbnails, xbel, launch, mime, theme watch, exif, text encodings, HEIC, eep cards + /app-icon) + the viewer's comics + the player's subtitles in every encoding
cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
cd apps/viewer && npx -y pnpm@11.13.0 tauri dev                 # dev with HMR (same for files, player)
cd apps/viewer && npx -y pnpm@11.13.0 tauri build --no-bundle   # → target/release/ewe-viewer
target/release/ewe-viewer --version      # {"ok":true,"name":"ewe-viewer","product":"ewe Viewer","version":"0.4.1-beta"}
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
  `ewe_app_core::handler![my_cmd]` — it already lists the core's. Every window goes through
  `window_builder` in app.rs: built hidden and then shown, with the theme's variant and page
  colour, and with the **boot script** (`window.__ewe = { theme, server, app, launch, dirs }`,
  `boot()` in the kit) — see "Start-up".
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
  `ffmpegthumbnailer` for video, embedded cover for audio, HEIC/AVIF/JPEG XL through
  `heif-dec`/`djxl`, 3 generations at once), `coverUrl`.
  `appIconUrl(server, path, mtime)` = `/app-icon?path=&m=&t=`: the icon an eep card embeds
  (PNG or SVG as it is, `nosniff` + a sandbox CSP, ETag = size + mtime → 304s).
  Only regular files under absolute paths; 403 without the token; the CSP allows
  `http://127.0.0.1:*` for img/media/connect only. `EWE_APPS_MEDIA_SERVER_FILE=<path>` makes the
  app write `{port, token}` there (tests, curl).
- **Text in any encoding** (`text.rs`, `/text/<name>?path=&t=[&enc=][&max=]`, `readText()` in
  @ewe/shared): a BOM (UTF-8/16) wins, then valid UTF-8, then BOM-less UTF-16 (NULs in every
  other byte), else Firefox's `chardetng` guesses with a hint — the language tag in the file
  name (`Movie.ru.srt` → `ru`) or the system locale (`LC_ALL`/`LC_CTYPE`/`LANG`) mapped to the
  TLD chardetng weighs — and `encoding_rs` decodes. The route answers UTF-8 with
  `X-Ewe-Encoding` (WHATWG name), `X-Ewe-Encoding-Confident` (0 = the hint swayed the guess)
  and `X-Ewe-Truncated`, all three exposed through CORS; `enc=` forces any WHATWG label, `max=`
  reads a prefix (default 2 MB, at most 32 MB; a character cut in half is dropped). Used by the
  Viewer's text view / Markdown / CSV, Files' quick look and preview, the Player's subtitles
  (`subtitle_vtt {path, encoding?}` → `{vtt, encoding, confident}`) and `.m3u` titles. The
  fixtures (`crates/core/tests/fixtures/text/`, written by Python's codecs with
  `make_text_fixtures.py`) are one subtitle in cp1251/1253/1254/1255/1256, GBK, GB18030, Big5,
  Shift_JIS, EUC-KR, Latin-1, UTF-16 with and without a BOM and UTF-8.
- **Phone pictures** (`picture.rs`, `/picture/<name>?path=&t=`, `pictureUrl()`): WebKitGTK 2.54
  shows AVIF and JPEG XL itself (libavif, libjxl) but has no HEIF decoder, so `.heic/.heif/.hif`
  go through `heif-dec -q 92` into `$XDG_CACHE_HOME/ewe-apps/pictures/<md5 uri>-<size>-<mtime>.jpg`
  (a changed file gets a new copy and the old one goes; least recently used pruned at 512 MB;
  two conversions at once; 30 s limit per decoder). heif-dec applies the HEIF rotation and
  writes EXIF orientation 1, so the JPEG is upright and WebKit does not turn it again; the info
  panel reads EXIF from the original (kamadak-exif reads HEIF). Thumbnails of HEIC/AVIF/JXL
  decode into a temp PNG (`heif-dec`, `djxl`, `avifdec`, then `magick`), or reuse the viewable
  copy when the Viewer already made one. `libheif` is a dependency of the package.
- **User text direction** (L4): every element that shows a name, title or tag (file rows,
  grid, crumbs, places, tabs, menus, song lists, Now playing, Viewer tabs/toolbars/start
  screen) carries `dir="auto"`; the kit's base.css gives `:where([dir='auto'])`
  `text-align: match-parent`, so an Arabic or Hebrew name reads right to left with its ellipsis
  at its own end but lines up with the left-to-right chrome (never mirrored). Text views use
  `unicode-bidi: plaintext` per paragraph/line. The font stacks get Noto faces for Arabic,
  Hebrew, Georgian, Armenian, the Indic scripts, Thai, Lao, Khmer, Myanmar and Ethiopic before
  `system-ui` (`SCRIPT_FONTS` / `withScriptFonts` in the kit's theme/parse.ts, mirrored in
  tokens.css); CJK is left to fontconfig (Source Han Sans by language).
- **Recent files** (`recent.rs`, `addRecent(path, mime?)`): parses `$XDG_DATA_HOME/
recently-used.xbel`, bumps or adds the entry with this app in `bookmark:applications`
  (`exec="'ewe-viewer %u'"`), prunes entries older than 30 days (GTK's default), writes atomically 0600. ewe Browser's Home and GTK dialogs read it.
- **Mime + apps** (`mime.rs`, commands `mime_of`, `apps_for {contentType, all?}`, `default_app`,
  `set_default_app {desktopId, contentType}`, `launch_with {desktopId|null, paths}`): GIO, on the
  main thread (GIO objects are not Send; these commands are sync) — except `mime_of`, which reads
  the file's first bytes and runs off it (only for a regular file: opening a FIFO never returns).
  An `AppInfo` carries `iconPath`, the icon's file from the GTK icon theme (`icon_file`, main
  thread): the page shows it with `rawUrl()`.
- **Open with** (`OpenWith` + `AppRows` in the kit, design system "File picker → Open with", the
  same card as the shell's `AppChooser.qml`): a 400px dialog, "Choose an app for “name”.", rows
  `control-2xl` tall with the app's own icon, the default first and chosen (`accent-subtle` + a
  check), six rows then it scrolls, "Other apps…" (every app + a search field), "Always use this
  app for <type> files", and in the footer "Find an app in Komble…" on the left, Cancel and Open.
  ↑ ↓ move, Enter or a double click opens. ewe Files (`OpenWithDialog`, also what `ewe-files-app
--open-with=<path>` and the Player's "Open with another app" show; Properties → Open with uses
  `AppRows`), ewe Viewer (the app menu, the picture's ⋯, the "cannot show this" page).
- **Shortcut keys** (`comboKey(e)` in `@ewe/shared`): the Latin letter of a key in lower case —
  `e.key` when it is one, else the letter printed on the key (`e.code`). Compare shortcuts with
  it, never with `e.key`: under Caps Lock `e.key` is "C", on the Georgian layout "ც", and Ctrl+C
  and friends were dead in both.
- **Kit conventions** (from ewe Browser): every on/off is a `Switch`, 2–5 choices a `Segmented`,
  menus are data (`MenuEntry[]`) rendered by `Menu` at a `Point`, `EmptyState` for empty pages,
  `toast()` for short confirmations, `Dialog` for anything modal. `.page` is `surface-raised`,
  headers `.app-header`, `.toolbar` rows with `.toolbar-spacer`. No `text-transform: uppercase`.
  Icons: add Lucide paths to `Icon.tsx` (`ICONS`), stroke 2, 24-box.

## Start-up (measure, do not guess)

`scripts/perf.sh <binary> <theme-dir|-> [args…]` launches the app in headless cage with
`EWE_APPS_TRACE=1` and prints the marks as ms since the launch (`PERF_RUNS`, default 5, then the
median): `main`, `setup`, `services`, `window`, `setup-done` from Rust (`crate::trace::mark`),
`page:script`, `page:fonts`, then `page:listed` / `page:painted` (Files: the first folder is in,
and drawn) or `page:ready` (Viewer: the picture or the first PDF page is drawn; `page:pdf-worker`
says pdf.js parses in a worker) from the page (`trace(label)` in the kit, once per label).
Without the variable a mark costs nothing. Run it with `HOME=<fixture>`.

Measured 2026-11-23 (release, headless cage, warm disk, medians of 5–7 runs, ±30 ms between
runs): ewe Files to a painted folder **568 → about 405 ms**, ewe Viewer to a 4000×3000 JPEG
**597 → 470–500 ms**, to a PDF's first page **686 → about 560 ms**. What the difference was, each found with strace (`pacman -Sp strace`, unpacked
into a temp dir — nothing installed):

- **A window is built hidden and then shown** (`window_builder` / `finish`). tao shows a window
  BEFORE it turns the decorations off; on Wayland GTK then builds its own title bar for that
  moment and loads three symbolic icons, and since gdk-pixbuf 2.44 every image is decoded by a
  sandboxed glycin loader that has to be spawned (bwrap) — ~40 ms of every launch (125 ms under
  strace) for a title bar nobody sees. Never load a pixbuf on the start-up path.
- **The page does not ask for what the core can hand it.** The first IPC answers come back ~45 ms
  after the first call, whatever is asked. The boot script puts the theme tokens, the media
  server, the app's identity, this window's launch and "which of its paths are folders" on
  `window.__ewe` before any script: `followTheme()` applies the theme in the same task (the first
  paint wears it), `getLaunch()` / `getMediaServer()` / `getAppVersion()` and Files'
  `api.windowLaunch()` resolve at once. The Viewer opens a tab at once and checks the file behind
  it. A window whose launch the core does not know gets `launch: null` and asks as before.
- **Render after the fonts** (`fontsReady()`, and the `<link rel="preload">`s in index.html). The
  faces are web fonts; text laid out before they arrive is measured with fallbacks, and WebKit
  finds a fallback by trying every family of the stack in turn, opening each font file — eighteen
  Noto script faces, none with a Latin letter, once per weight and size: 190 files, 150–250 ms.
- **The Latin face second** (`LATIN_FALLBACK` in theme/parse.ts, mirrored in tokens.css): "Noto
  Sans" / "Noto Sans Mono" right after Geist, before the script faces. A character Geist lacks —
  the narrow no-break space ICU writes in "5:45 PM" — walked the whole stack the same way, in
  every list of dates.
- **ewe Files' window loads 223 KB of script, not 2 MB**: pdf.js (+ its worker) and highlight.js,
  marked, DOMPurify are chunks fetched on first use (`pdfthumb.ts`, `lazy()` in viewer.tsx).
- tao asks the portal for the colour scheme unless the builder gets a theme: it gets the tokens'
  variant.

What is left is GTK's own start (~105 ms to `setup`) and WebKit's (~165 ms from the window to
the page's script).

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
                            relative images → raw URLs, first 2 MB, Source / Preview, wrap, text size;
                            text from the core's /text in any encoding, the toolbar's encoding button
                            opens Automatic + TEXT_ENCODINGS (the choice remembered per file)
src/views/DocxView.tsx      docx-preview (pages, zoom, Ctrl+P prints the document itself)
src/views/SheetView.tsx     SheetJS for xlsx/xlsm/xls/ods (dense sheets), lib/csv.ts for csv/tsv; column
                            letters, frozen header row, one tab per sheet, first 5000 rows
src/views/ImageView.tsx     fit / actual / zoom at the cursor / drag, pinch (gesture events), rotate,
                            flip, slideshow, ←/→ through the folder (folder_images), info panel (stat +
                            EXIF rows from lib/exif.ts), copy (wl-copy), set as wallpaper (ewe-conf),
                            move to Trash (GIO), Open with…; HEIC/HEIF through the core's /picture.
                            `current` is the picture asked for, `shown` the one on the stage: the next
                            one is decoded off the page and swapped in with its size (no flash at 100 %,
                            no easing on a swap or while the window resizes); the tab, the title and
                            the app menu follow it (`onPath`). A wheel notch is a zoom step, a touchpad
                            swipe zooms as far as it travels (lib/wheel.ts)
src/views/OtherView.tsx     ODT / PPTX / DOC…: type, size, GIO apps, "Open with the default app"
src/views/Start.tsx         recent documents from recently-used.xbel (recent_documents), thumbnails from
                            the core's cache for pictures and pdf.js' first page for PDFs
src/lib/{kinds,memory,csv,exif,flags,wheel}.ts   pure, unit-tested (vitest in apps/viewer);
                            wheel.ts: `isNotch`, `wheelStepper` (one step per notch or per stretch of
                            a swipe; `once` = one page per swipe), `smoothZoomFactor`
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
page modes move into ⋯. The picture toolbar: below 640 Previous/Next (the arrows over the
picture and ← → stay), Fit, Rotate and Slideshow leave it (the last three join ⋯) and the zoom
shows only its percent; below 430 the − / + buttons and the meta line go too. The image info
panel takes at most half the window, the PDF/book sidebar at most 45 %.

Launch flags (all `--key=value`, for the paths on the same command line): `--page=N`, `--find=text`,
`--sidebar=pages|contents`, `--mode=continuous|single|two`, `--zoom=page-width|page-fit|1.5`,
`--night`, `--present`, `--fill=field=value` (PDF); `--toc`, `--flow=paged|scrolled`,
`--theme=auto|light|sepia|dark` (books); `--spread` (comics); `--source` (Markdown); `--sheet=N`
(spreadsheets); `--info`, `--slideshow`, `--zoom=200` (pictures); `--encoding=windows-1251` (text:
read as that, not remembered), `--encoding-menu` (opens the encoding menu); `--open-with` (the
Open with card for the first file). They are also how `scripts/shot.sh` reaches every state
headless.

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
  apps.rs                 eep's side: follows eep's activity file (`eep-activity`), `eep card` for the
                          Install view (`eep_card`), `eep add` detached (`eep_add` → `eep-add`)
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
src/install.tsx           the Install view (a dialog here, and the small `--install=` window)
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
- **The pane, small print** (0.4.1): search results are not a folder — `reload()` (F5, an
  `fs-changed`, an undo) leaves them, `forget(paths)` drops rows that were trashed, and Rename /
  New folder are off there. Shift+arrows extend from the anchor (a separate `cursor`). The rename
  field's value is set once (a reload must not put the old name back) and New folder / New file
  start the rename when the listing is in (`reload()` returns its promise). Moving to the Trash
  shows ONE toast with Undo, and its listener is there before the job starts. PDF thumbnails are
  drawn one at a time, newest first (pdf.js runs on the page's thread here); the quick look draws
  a PDF's pages as they come near. The folder watcher speaks at least once a second during a long
  burst of changes (a download being written).
- Files open with the GIO default (`launch_with(null)`), archives in the archive dialog, programs
  and AppImages through the Run dialog (Komble install offered).
- **eep cards** (`<Name>.eep`, `../eep/docs/CARD.md`): the card in `~/Applications` IS the app
  (`eep watch` installs a card that arrives, uninstalls one that leaves; since eep 0.2 every app on
  the computer has one — a found app's card, `source = "system"`, hides or shows its app instead of
  uninstalling it, and reads the same here). `fs::entry_for` reads any
  `.eep` through the core's `eep::card` (TOML; `id` + `name` required, else it is a plain file;
  cached per path + size + mtime + inode) into `Entry.app` {name, id, version, kind, icon, system,
  from, ready} — also on Trash rows and search hits (found by the app's name too). The page shows
  `displayName()` (the card's `name`, no `.eep`) everywhere, sorts and filters by it, kind `app`
  ("App", `app-window`), the icon from `/app-icon` (`fm-thumb--app`: contain, no backdrop).
- **Applications is not a folder like the others** (0.4, eep 0.3; `App.tsx` "apps", `install.tsx`,
  `src-tauri/apps.rs`). A card there is an app:
  - **Ready or not.** `AppCard.ready` (the core's `eep::fetched`, asked on every listing — never
    cached, it changes without the card changing): an eep app is ready when
    `$XDG_STATE_HOME/eep/roots/<id>` links to the card's `out`; a found app always is. How far an
    install is comes from eep's activity file (`$XDG_RUNTIME_DIR/eep/activity.json`): `apps.rs`
    follows it (notify on the folder, plus a re-read every 3 s while something is in flight — an
    eep that was killed says nothing more; entries of a dead pid are not read) and emits
    `eep-activity [entries]`; `useEepActivity()` keeps it. `appStanding(app, activity)` in
    `@ewe/shared` → `ready | updating | waiting | installing | finishing | failed`; a tile that is
    not ready dims its icon behind a ring (`.fm-ring`, an arc out of 100; it turns while the size
    is unknown) and gives the name's second line to "Installing 43%" (`.fm-label`), the list's Type
    column says the same, the Applications place shows "43%", the status line counts
    "N installing". When the set of apps eep works on changes, panes on Applications reload (an
    install that ends does not touch the card).
  - **A click** (`openApp`): ready → `eep open <card>` (`eep_open`: eep execs the app, which keeps
    eep's stdout — an `sh` pipeline hands Files the first line → `eep-open {window, id, error}`
    replaces the "Opening…" toast, and drains the rest for the app's life). Still installing → a
    toast says how far. Waiting with no eep at it, or failed → `eep_add` (Install now).
  - **Menus**: Open (or Install now / Try again) · Remove app (a found app: Hide app; one still
    installing: Cancel install — the card goes to the Trash and eep drops the download) ·
    Properties. No Open with, Cut, Rename (F2 does nothing: an app is called what its card says
    inside), Compress, links. The background: Get apps… (Komble), Paste, Select all, Grid/List,
    Refresh. New folder is off. Ctrl+X refuses ("Apps stay in Applications"); a card dragged OUT
    is copied, never moved (only the Trash removes an app); cards copied or moved IN say
    "Installing…" (with Show) instead of the operations panel.
  - **A card anywhere else** is an app to install: `openApp` opens the Install view (`install.tsx`
    `InstallView`): the app's icon and name over **Install**, with "Version x · N MB to download"
    from `eep_card` (`eep card <file>`: `installed`, `ready`, `download`). Install = `eep_add`
    (`eep add <card>`, in its own session: the card MOVES into Applications and the app is fetched;
    `eep-add {window, id, ok, error, card, appId}` when done) → the bar and "Installing… 43% ·
    114 MB of 264 MB" from the activity → **Open** / Done, or the error and Try again. Hide lets it
    go on (App.tsx then toasts the end: `watchAdd`); Cancel trashes the card. The same view is the
    whole of a small window for a card clicked outside Files: eep's handler runs `eep open --ask`,
    which execs `ewe-files-app --install=<card>` → `install_shape` (lib.rs) opens the window with
    `window.__eweView = 'install'` set before any script (`open_shaped` in the core;
    `index.tsx` renders `InstallWindow`), titled `INSTALL_TITLE` — ewe's Hyprland rule
    `eep-install` matches that title to float it, centred, 400×380 (`INSTALL_SIZE`); change one,
    change both. It is an ordinary resizable window on purpose: a fixed-size one floats on
    Hyprland by itself but at the size of the whole screen.
  - Without eep a card is never handed to the GIO default (that opened a text editor or a
    folder): Files says "update ewe: it brings eep". An empty Applications says where apps come
    from (`fm-empty-hint`). The place "Applications" (`$EEP_APPS_DIR` or `~/Applications`,
    `places::apps_dir`) sits right under Home even before the folder exists; `list_dir` makes it
    on first open (`ensure_apps_dir`).
- **The windowed grid has ONE row height** (0.4). `pane.tsx` keeps only the rows near the
  viewport in the DOM, by arithmetic (`listWindow` in `@ewe/shared`, tested). So every tile is
  one height — files.css keeps two lines for a name whether it fills them or not — `measure()`
  reads ONE tile's height and the grid's own column tracks (`getComputedStyle`), and nothing it
  reads depends on WHICH rows are rendered. 0.3.1 measured the first rendered row and counted
  the tiles beside it: in a folder with one- and two-line names (Applications) each window
  measured another height, each height asked for another window, and the page never came back
  from its microtasks (frozen, 100 % CPU; closing the window left a WebKit watchdog core dump).
  Never make a tile's height depend on its content, and never measure from "the first rendered
  row". Repro of the old bug: `--shot=applications --shot-height=656`, eight Down keys.
- `--shot=list|grid|split|menu|copy|conflict|properties|openwith|archive|trash|quicklook|search|rename|preview|ops-preview|split-list|grid-preview|places|applications|open|install|app-menu|more|tabs|compress`
  puts a fresh window into that state (used for the screenshots; `quicklook` shows the row a
  `--select=` picked); `--shot-width=900` /
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
src/video/VideoPlayer.tsx  <video> (crossorigin for local files only) + the auto-hiding control bar (seek with buffered
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
  `subs` (the first .srt sidecar on), `subs-menu`, `subs-encoding` (that one on + the Subtitle
  encoding menu), `audio-menu`, `playlist`, `mini`, `music-albums`, `music-album`, `music-songs`,
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

- **Every notify watcher must drop `EventKind::Access(_)`** — its inotify mask includes OPEN and
  CLOSE_NOWRITE, so the watcher's own read of the file is an event. `theme.rs` did not: one read
  of theme-tokens.json started a loop, `theme-changed` five times a second for as long as any of
  the three apps ran, and the page re-set every CSS variable on `:root` each time (0.4.0 and
  before). `followTheme` also ignores tokens equal to the last ones.
- **`on(() => props.x.y, fn)` runs `fn` on every re-evaluation, not only when the value changes.**
  Wrap the source in `createMemo` when the callback must follow the VALUE: the pane's
  "hidden toggled" effect listed every folder twice (and every pane on a zoom step), and a tile's
  thumbnail state reset to "loading" on each reload while its `<img>` (same src) never fired
  `load` again.
- **A ResizeObserver callback that changes layout in the same frame** logs "ResizeObserver loop
  completed with undelivered notifications" (an `error` event). Set the state in the next
  animation frame. A hidden tab (`display: none`) is 0 × 0: ignore that size, it is not a resize
  (pdf.js computed a negative scale and threw every page away; a picture was "Fit · 0%").
- **Locks in ops.rs: never a job's `progress` while `state` is held** (`list()` clones the jobs
  out first). A job that finished while the page asked for the list deadlocked the app.
- **A copy onto itself** (paste into the same folder) gets a new name without a question;
  `place()` never removes the file it is about to copy, and a folder is never copied into
  itself. A merge moves child by child (what was skipped stays in the source). A stopped copy
  removes its half file.
- **`<For>` keys by identity**: a list fed fresh objects many times a second (operations) rebuilds
  its rows, and a button pressed between two updates is gone before the click. `<Index>` there.
- **A `Dialog` keeps its keys** (`stopPropagation`): window-level shortcuts are not for a covered
  page. `Menu` closes on a press outside any `.menu` (capture phase) and scrolls when taller than
  the window. A clicked tab does not take the keyboard (`mousedown` prevented), so ← → and Delete
  stay with the document. A `Field` with `autofocus` keeps the focus (the dialog used to move it
  to the primary button a microtask later).
- **bsdtar takes a member name as a pattern**: `[Group] Title/001.jpg` matched nothing.
  `glob_escape` in comics.rs.

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
- **`system-ui` is not a fontconfig family on Arch**: WebKitGTK resolves it to whatever
  fontconfig matches first for the character, and with GNU FreeFont installed (the `ttf-font`
  provider) that is FreeMono for Arabic — letters unjoined, typewriter-spaced — and FreeSans
  for Hebrew. Named Noto faces before `system-ui` fix it (`withScriptFonts`); ewe's own
  fonts.conf only names Georgian and CJK.
- `text-overflow: ellipsis` follows the direction of the element that clips: `dir="auto"` must
  sit on that element (wrap a label in its own span when the clipping element is a button or
  a flex container with an icon — `.fm-crumb-label`), not on an inner span.
- `heif-dec` writes `out-1.jpg`, `out-2.jpg` … instead of `out.jpg` when a file holds several
  top-level pictures (bursts): `picture::settle` keeps the first. It decodes AVIF too (dav1d).
- `chardetng` 1.0 has no confidence score: `confident` = the guess is the same with and without
  the language hint and decoding had no errors. Give it whole files when you can (`complete`):
  a prefix must be fed with `last = false` or a cut character counts against the guess.
