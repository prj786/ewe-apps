// ewe Player: pure helpers for the video player and the queue (no DOM, tested with vitest).

import { extensionOf, fileKind } from './files'

/** What the player can open: a local file (served by the core) or a remote stream. */
export interface MediaItem {
  /** absolute path, or the URL for a stream */
  path: string
  name: string
  kind: 'video' | 'audio'
  /** `http(s)://…` streams (HLS included) have no file behind them */
  remote: boolean
}

export type RepeatMode = 'off' | 'all' | 'one'

export const SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const MIN_SPEED = 0.25
export const MAX_SPEED = 3
/** volume above 1 goes through a Web Audio gain node */
export const MAX_VOLUME = 1.5

export function stepSpeed(current: number, direction: 1 | -1): number {
  const sorted = SPEEDS
  if (direction > 0) return sorted.find((s) => s > current + 1e-9) ?? MAX_SPEED
  return [...sorted].reverse().find((s) => s < current - 1e-9) ?? MIN_SPEED
}

export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2)).toString()}×`
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.min(MAX_VOLUME, Math.max(0, volume))
}

/** The hover-time label and the clock: `m:ss`, `h:mm:ss`, `-m:ss` for remaining time. */
export function formatClock(seconds: number, negative = false): string {
  if (!Number.isFinite(seconds)) return '–:––'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  const text = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
  return negative ? `-${text}` : text
}

/**
 * Which item plays after `index` ends (or Next is pressed): null means stop.
 * `manual` wraps at the end even when repeat is off, like every player does.
 */
export function nextIndex(
  index: number,
  length: number,
  repeat: RepeatMode,
  manual: boolean,
): number | null {
  if (length === 0) return null
  if (!manual && repeat === 'one') return index
  if (index + 1 < length) return index + 1
  if (repeat === 'all' || manual) return 0
  return null
}

export function previousIndex(index: number, length: number): number | null {
  if (length === 0) return null
  return (index - 1 + length) % length
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function dirName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

export function mediaKind(name: string): 'video' | 'audio' | null {
  const kind = fileKind({ name, dir: false })
  return kind === 'video' || kind === 'audio' ? kind : null
}

export function isRemoteUrl(text: string): boolean {
  return /^(https?|rtsp|rtmp):\/\/\S+$/i.test(text.trim())
}

/** A playable item from a path or URL (null when the name says it is not media). */
export function toMediaItem(pathOrUrl: string): MediaItem | null {
  if (isRemoteUrl(pathOrUrl)) {
    const url = pathOrUrl.trim()
    let name = url
    try {
      const u = new URL(url)
      const last = baseName(u.pathname)
      name = last === '' || last === '/' ? u.host : decodeURIComponent(last)
    } catch {
      name = url
    }
    return { path: url, name, kind: 'video', remote: true }
  }
  const name = baseName(pathOrUrl)
  const kind = mediaKind(name)
  if (kind === null) return null
  return { path: pathOrUrl, name, kind, remote: false }
}

export function sortMedia(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => naturalCompare(a.name, b.name))
}

/** The language of `Movie.en.srt` / `Movie.eng.forced.srt` next to `Movie.mkv`, in words. */
export function subtitleLabel(subtitlePath: string, videoPath: string): string {
  const stem = stemOf(baseName(subtitlePath))
  const videoStem = stemOf(baseName(videoPath))
  let rest = stem.startsWith(videoStem) ? stem.slice(videoStem.length) : stem
  rest = rest.replace(/^[\s._-]+/, '')
  if (rest === '') return `Subtitles (${extensionOf(baseName(subtitlePath)).toUpperCase()})`
  const parts = rest.split(/[._-]/).filter((p) => p !== '')
  const words: string[] = []
  let flags: string[] = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'forced' || lower === 'sdh' || lower === 'cc') {
      flags.push(lower === 'sdh' || lower === 'cc' ? 'SDH' : 'forced')
      continue
    }
    const language = languageName(lower)
    words.push(language ?? part)
  }
  flags = [...new Set(flags)]
  const label = words.join(' ')
  return flags.length === 0 ? label : `${label} (${flags.join(', ')})`
}

export function languageName(code: string): string | null {
  if (!/^[a-z]{2,3}$/i.test(code)) return null
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'language' })
    const name = names.of(code.toLowerCase())
    if (name === undefined || name.toLowerCase() === code.toLowerCase()) return null
    return name
  } catch {
    return null
  }
}

/** ffprobe / GStreamer codec ids → plain words and whether gst-libav is the decoder for it. */
export function codecWords(codec: string): { label: string; needsLibav: boolean } {
  const c = codec.toLowerCase()
  const table: Record<string, [string, boolean]> = {
    h264: ['H.264 video', false],
    avc: ['H.264 video', false],
    hevc: ['HEVC (H.265) video', false],
    h265: ['HEVC (H.265) video', false],
    vp8: ['VP8 video', false],
    vp9: ['VP9 video', false],
    av1: ['AV1 video', false],
    theora: ['Theora video', false],
    mpeg2video: ['MPEG-2 video', false],
    mpeg1video: ['MPEG-1 video', true],
    mpeg4: ['MPEG-4 Part 2 video (DivX / Xvid)', true],
    msmpeg4v1: ['Microsoft MPEG-4 video', true],
    msmpeg4v2: ['Microsoft MPEG-4 video', true],
    msmpeg4v3: ['Microsoft MPEG-4 (DivX 3) video', true],
    wmv1: ['Windows Media video', true],
    wmv2: ['Windows Media video', true],
    wmv3: ['Windows Media video 9', true],
    vc1: ['VC-1 video', true],
    mjpeg: ['Motion JPEG video', false],
    prores: ['Apple ProRes video', true],
    dnxhd: ['Avid DNxHD video', true],
    h263: ['H.263 video', true],
    flv1: ['Flash video', true],
    rv40: ['RealVideo', true],
    aac: ['AAC audio', false],
    mp3: ['MP3 audio', false],
    mp2: ['MPEG audio layer 2', true],
    opus: ['Opus audio', false],
    vorbis: ['Vorbis audio', false],
    flac: ['FLAC audio', false],
    alac: ['Apple Lossless audio', true],
    ac3: ['Dolby Digital (AC-3) audio', true],
    eac3: ['Dolby Digital Plus (E-AC-3) audio', true],
    truehd: ['Dolby TrueHD audio', true],
    dts: ['DTS audio', true],
    wmav1: ['Windows Media audio', true],
    wmav2: ['Windows Media audio', true],
    wmapro: ['Windows Media audio Pro', true],
    wmalossless: ['Windows Media audio Lossless', true],
    cook: ['RealAudio', true],
    amr_nb: ['AMR audio', true],
    ape: ['Monkey’s Audio', true],
    tta: ['TTA audio', true],
    wavpack: ['WavPack audio', false],
  }
  if (c.startsWith('pcm_')) return { label: 'uncompressed PCM audio', needsLibav: false }
  if (c.startsWith('adpcm_')) return { label: 'ADPCM audio', needsLibav: true }
  const hit = table[c]
  if (hit !== undefined) return { label: hit[0], needsLibav: hit[1] }
  return { label: `${codec} (unknown codec)`, needsLibav: true }
}

/** One stream as ffprobe reports it (the core's `probe_media`). */
export interface ProbedStream {
  kind: 'video' | 'audio' | 'subtitle' | 'other'
  codec: string
  language: string | null
  title: string | null
}

/** The sentence shown when GStreamer refuses a file. */
export function decodeFailureMessage(
  name: string,
  streams: ProbedStream[] | null,
  mediaErrorCode: number | null,
): { title: string; detail: string; suggestLibav: boolean } {
  const media = (streams ?? []).filter((s) => s.kind === 'video' || s.kind === 'audio')
  if (media.length === 0) {
    const detail =
      mediaErrorCode === 2
        ? 'The file could not be read to the end.'
        : 'The format of this file is not one GStreamer on this machine understands.'
    return { title: `Cannot play ${name}`, detail, suggestLibav: true }
  }
  const words = media.map((s) => codecWords(s.codec))
  const list = [...new Set(words.map((w) => w.label))]
  const joined =
    list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1) ?? ''}`
  const suggestLibav = words.some((w) => w.needsLibav)
  return {
    title: `Cannot play ${name}`,
    detail: `It uses ${joined}. ${
      suggestLibav
        ? 'Decoding it needs the gst-libav package (FFmpeg codecs for GStreamer).'
        : 'The decoder for it is missing or refused the file.'
    }`,
    suggestLibav,
  }
}

/** Where you left off: kept per file, only when it is worth resuming. */
export interface SavedPosition {
  position: number
  duration: number
  at: number
}

export const MAX_SAVED_POSITIONS = 500

export function rememberPosition(
  saved: Record<string, SavedPosition>,
  path: string,
  position: number,
  duration: number,
  now = Date.now(),
): Record<string, SavedPosition> {
  const next = { ...saved }
  const worth = duration > 60 && position > 5 && position < duration - 10
  if (!worth) {
    delete next[path]
    return next
  }
  next[path] = { position, duration, at: now }
  const keys = Object.keys(next)
  if (keys.length > MAX_SAVED_POSITIONS) {
    keys
      .sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0))
      .slice(0, keys.length - MAX_SAVED_POSITIONS)
      .forEach((k) => delete next[k])
  }
  return next
}

/** Move an item inside a list (drag to reorder). */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to > items.length) return items
  const out = [...items]
  const [moved] = out.splice(from, 1)
  if (moved === undefined) return items
  out.splice(to > from ? to - 1 : to, 0, moved)
  return out
}
