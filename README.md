# ewe apps

Three apps for the ewe desktop, in one repo and one Arch package (`ewe-apps`):

- **ewe Files** (`ewe-files-app`) — your files, folders, drives and archives.
- **ewe Player** (`ewe-player`) — videos and music.
- **ewe Viewer** (`ewe-viewer`) — PDFs, books, pictures, text and spreadsheets.

They look like ewe Browser and follow the ewe theme (scheme, accent, text size,
reduce motion) live. Tauri 2 on the system WebKitGTK, Solid + TypeScript in the
window, Rust underneath. Nothing stays running when the window is closed.

## Build

```
npx -y pnpm@11.13.0 install
npx -y pnpm@11.13.0 typecheck && npx -y pnpm@11.13.0 lint && npx -y pnpm@11.13.0 test
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd apps/viewer && npx -y pnpm@11.13.0 tauri build --no-bundle   # → target/release/ewe-viewer
```

`AGENTS.md` has the map of the repo, the verify loop and the gotchas;
`docs/PLAN.md` the plan and what each app will do.

GPL-3.0-only. Geist and Geist Mono are OFL (`packages/ui/src/fonts/Geist-OFL.txt`);
the icons are Lucide (ISC).
