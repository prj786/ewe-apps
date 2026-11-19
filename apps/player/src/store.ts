// What the player remembers between runs (localStorage, like ewe Browser's music page).
import { clampVolume, type RepeatMode, type SavedPosition } from '@ewe/shared'

export type FitMode = 'contain' | 'cover' | 'zoom'
export type SubSize = 'small' | 'normal' | 'large' | 'huge'
export type SubPosition = 'bottom' | 'raised' | 'top'
export type MusicView = 'albums' | 'artists' | 'songs' | 'playlists' | 'queue'

export interface VideoPrefs {
  volume: number
  muted: boolean
  fit: FitMode
  subSize: SubSize
  subPosition: SubPosition
  panel: boolean
  remainingTime: boolean
}

export interface MusicPrefs {
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  queue: string[]
  index: number
  view: MusicView
}

export interface PlayerState {
  mode: 'video' | 'music'
  video: VideoPrefs
  music: MusicPrefs
  positions: Record<string, SavedPosition>
}

const KEY = 'ewe.player.state'

export const DEFAULT_STATE: PlayerState = {
  mode: 'video',
  video: {
    volume: 1,
    muted: false,
    fit: 'contain',
    subSize: 'normal',
    subPosition: 'bottom',
    panel: false,
    remainingTime: false,
  },
  music: { volume: 0.8, repeat: 'off', shuffle: false, queue: [], index: 0, view: 'albums' },
  positions: {},
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function loadState(): PlayerState {
  const base = DEFAULT_STATE
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!isRecord(raw)) return base
    const v = isRecord(raw.video) ? raw.video : {}
    const m = isRecord(raw.music) ? raw.music : {}
    const positions: Record<string, SavedPosition> = {}
    if (isRecord(raw.positions)) {
      for (const [path, p] of Object.entries(raw.positions)) {
        if (
          isRecord(p) &&
          typeof p.position === 'number' &&
          typeof p.duration === 'number' &&
          typeof p.at === 'number'
        )
          positions[path] = { position: p.position, duration: p.duration, at: p.at }
      }
    }
    return {
      mode: pick(raw.mode, ['video', 'music'], base.mode),
      video: {
        volume: typeof v.volume === 'number' ? clampVolume(v.volume) : base.video.volume,
        muted: v.muted === true,
        fit: pick(v.fit, ['contain', 'cover', 'zoom'], base.video.fit),
        subSize: pick(v.subSize, ['small', 'normal', 'large', 'huge'], base.video.subSize),
        subPosition: pick(v.subPosition, ['bottom', 'raised', 'top'], base.video.subPosition),
        panel: v.panel === true,
        remainingTime: v.remainingTime === true,
      },
      music: {
        volume:
          typeof m.volume === 'number' ? Math.min(1, Math.max(0, m.volume)) : base.music.volume,
        repeat: pick(m.repeat, ['off', 'all', 'one'], 'off'),
        shuffle: m.shuffle === true,
        queue: Array.isArray(m.queue)
          ? m.queue.filter((x): x is string => typeof x === 'string')
          : [],
        index: typeof m.index === 'number' ? m.index : 0,
        view: pick(m.view, ['albums', 'artists', 'songs', 'playlists', 'queue'], 'albums'),
      },
      positions,
    }
  } catch {
    return base
  }
}

export function saveState(state: PlayerState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    return
  }
}
