import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppVersion, Launch, MediaServer } from '@ewe/shared'

/**
 * What the core put on the window before any script ran (`boot_script` in
 * crates/core/src/app.rs): the theme tokens, the media server, the app, and what
 * this window was asked to open. Asking for them over IPC cost the first folder or
 * picture ~45 ms; each getter still asks when its part is missing (a dev page
 * opened in a browser, an older core).
 */
export interface Boot {
  theme?: unknown
  server?: MediaServer | null
  app?: AppVersion | null
  launch?: Launch | null
  /** for each of `launch.paths`: is it a folder */
  dirs?: boolean[] | null
}

export function boot(): Boot {
  return (globalThis as { __ewe?: Boot }).__ewe ?? {}
}

/** The paths and flags this window was started with. */
export function getLaunch(): Promise<Launch> {
  const known = boot().launch
  return known === undefined || known === null
    ? invoke<Launch>('launch_args')
    : Promise.resolve(known)
}

/** A second launch of the same app forwarded its argv (single instance). */
export function onLaunch(handler: (launch: Launch) => void): () => void {
  let off: (() => void) | null = null
  let stopped = false
  void listen<Launch>('launch', (event) => {
    if (!stopped) handler(event.payload)
  }).then((stop) => {
    if (stopped) stop()
    else off = stop
  })
  return () => {
    stopped = true
    off?.()
  }
}

/** Port and token of the core's loopback media server (see `rawUrl` in @ewe/shared). */
export function getMediaServer(): Promise<MediaServer> {
  const known = boot().server
  return known === undefined || known === null
    ? invoke<MediaServer>('media_server')
    : Promise.resolve(known)
}

export function getAppVersion(): Promise<AppVersion> {
  const known = boot().app
  return known === undefined || known === null
    ? invoke<AppVersion>('app_version')
    : Promise.resolve(known)
}

/**
 * A start-up mark for `scripts/perf.sh` (the core prints it only under
 * `EWE_APPS_TRACE=1`): the page's own clock, so it lines up with the Rust marks.
 * Each label is sent once.
 */
const traced = new Set<string>()
export function trace(label: string): void {
  if (traced.has(label)) return
  traced.add(label)
  const at = performance.timeOrigin + performance.now()
  void invoke('trace_mark', { label, at }).catch(() => undefined)
}

/** Record a file in ~/.local/share/recently-used.xbel (what ewe Browser's Home lists). */
export async function addRecent(path: string, mimeType?: string): Promise<void> {
  await invoke<null>('add_recent', { path, mimeType: mimeType ?? null })
}
