// The player's own commands (the shared ones are in @ewe/ui's bridge).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { MusicLibrary, ProbedStream, RepeatMode, Track } from '@ewe/shared'

export interface Library extends MusicLibrary {
  /** `.m3u` / `.m3u8` files found under the roots */
  playlists: string[]
}

export interface MediaFile {
  path: string
  kind: 'video' | 'audio'
}

export interface PlaylistEntry {
  path: string
  title: string | null
  duration: number | null
}

export interface RecentItem {
  path: string
  name: string
  mime: string | null
  modified: string
}

export interface Places {
  music: string
  videos: string
  playlists: string
  screenshots: string
}

export interface TrackMeta {
  id: string
  title: string
  artist?: string | null
  album?: string | null
  length?: number | null
  url?: string | null
  artUrl?: string | null
  trackNumber?: number | null
}

export interface MprisUpdate {
  status?: 'playing' | 'paused' | 'stopped'
  repeat?: RepeatMode
  shuffle?: boolean
  rate?: number
  volume?: number
  position?: number
  seeked?: boolean
  canNext?: boolean
  canPrevious?: boolean
  metadata?: TrackMeta
  fullscreen?: boolean
}

export type MprisAction =
  | 'raise'
  | 'fullscreen'
  | 'next'
  | 'previous'
  | 'pause'
  | 'play-pause'
  | 'stop'
  | 'play'
  | 'seek'
  | 'set-position'
  | 'open-uri'
  | 'repeat'
  | 'rate'
  | 'shuffle'
  | 'volume'

export interface MprisCommand {
  action: MprisAction
  value?: unknown
}

export const musicLibrary = (): Promise<Library> => invoke<Library>('music_library')
export const musicRescan = (): Promise<Library> => invoke<Library>('music_rescan')
export const trackInfo = (paths: string[]): Promise<Track[]> =>
  invoke<Track[]>('track_info', { paths })
export const listMedia = (paths: string[]): Promise<MediaFile[]> =>
  invoke<MediaFile[]>('list_media', { paths })
export const subtitleFiles = (video: string): Promise<string[]> =>
  invoke<string[]>('subtitle_files', { video })
export const subtitleVtt = (path: string): Promise<string> =>
  invoke<string>('subtitle_vtt', { path })
export const playlistLoad = (path: string): Promise<PlaylistEntry[]> =>
  invoke<PlaylistEntry[]>('playlist_load', { path })
export const playlistSave = (path: string, entries: PlaylistEntry[]): Promise<void> =>
  invoke<null>('playlist_save', { path, entries }).then(() => undefined)
export const probeMedia = (target: string): Promise<ProbedStream[]> =>
  invoke<ProbedStream[]>('probe_media', { target })
export const screenshotFrame = (
  path: string,
  time: number,
): Promise<{ path: string; name: string }> =>
  invoke<{ path: string; name: string }>('screenshot_frame', { path, time })
export const recentMedia = (): Promise<RecentItem[]> => invoke<RecentItem[]>('recent_media')
/** Float (or tile) the window on Hyprland for the mini player; a no-op elsewhere. */
export const hyprFloat = (on: boolean): Promise<void> =>
  invoke<null>('hypr_float', { on }).then(() => undefined)
export const coverArtFile = (path: string): Promise<string | null> =>
  invoke<string | null>('cover_art_file', { path })
export const mprisUpdate = (update: MprisUpdate): Promise<void> =>
  invoke<null>('mpris_update', { update }).then(() => undefined)
export const inhibitIdle = (on: boolean): Promise<boolean> =>
  invoke<boolean>('inhibit_idle', { on })
export const playerPlaces = (): Promise<Places> => invoke<Places>('player_places')
export const launchWith = (desktopId: string | null, paths: string[]): Promise<void> =>
  invoke<null>('launch_with', { desktopId, paths }).then(() => undefined)

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- it types the handler for callers
function subscribe<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | null = null
  let stopped = false
  void listen(name, (e: { payload: T }) => {
    if (!stopped) handler(e.payload)
  }).then((stop) => {
    if (stopped) stop()
    else off = stop
  })
  return () => {
    stopped = true
    off?.()
  }
}

/** Resolves once the listener is registered — call `musicLibrary()` after, or a fast scan's
 *  `music-changed` can fire before the webview listens. */
export const onMusicChanged = (handler: (library: Library) => void): Promise<() => void> =>
  listen('music-changed', (e: { payload: Library }) => handler(e.payload))
export const webviewTune = (): Promise<void> => invoke<null>('webview_tune').then(() => undefined)
export const onMprisCommand = (handler: (command: MprisCommand) => void): (() => void) =>
  subscribe<MprisCommand>('mpris-command', handler)

/** What a view hands the app so keys and MPRIS reach whichever player is active. */
export interface Transport {
  toggle(): void
  play(): void
  pause(): void
  stop(): void
  next(): void
  previous(): void
  seekBy(seconds: number): void
  seekTo(seconds: number): void
  volumeBy(delta: number): void
  setVolume(volume: number): void
  setRate(rate: number): void
  setRepeat(mode: RepeatMode): void
  setShuffle(on: boolean): void
  toggleMute(): void
}
