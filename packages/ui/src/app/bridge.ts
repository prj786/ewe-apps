import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppVersion, Launch, MediaServer } from '@ewe/shared'

/** The paths and flags this process was started with. */
export function getLaunch(): Promise<Launch> {
  return invoke<Launch>('launch_args')
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
  return invoke<MediaServer>('media_server')
}

export function getAppVersion(): Promise<AppVersion> {
  return invoke<AppVersion>('app_version')
}

/** Record a file in ~/.local/share/recently-used.xbel (what ewe Browser's Home lists). */
export async function addRecent(path: string, mimeType?: string): Promise<void> {
  await invoke<null>('add_recent', { path, mimeType: mimeType ?? null })
}
