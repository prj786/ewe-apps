// ewe Player and web links: what a link is (a media file, a stream, a web page with a video
// on it) and the shapes the core's `resolve_link` / `media_support` answer. Pure, tested.

/** What this machine can do for the player (the core's `media_support`, cached). */
export interface MediaSupport {
  /** gst-libav (FFmpeg decoders for GStreamer) is installed */
  libav: boolean
  /** yt-dlp is on PATH (or $EWE_PLAYER_YTDLP): videos from web pages */
  ytdlp: boolean
  /** mpv is on PATH: the fallback for what WebKit cannot stream */
  mpv: boolean
}

/** Why a link did not give a stream. */
export type LinkProblem =
  | 'no-ytdlp' // a web page, and yt-dlp is not installed
  | 'no-video' // a web page yt-dlp finds no video on (or a site it does not know)
  | 'drm' // the site locks the video (DRM)
  | 'unplayable' // there is a video, but only in pieces WebKit cannot stream
  | 'error' // yt-dlp failed (login, private, region, the network…): see `message`

export interface LinkEntry {
  url: string
  title: string | null
  duration: number | null
}

/** The core's answer for an http(s) link. */
export interface ResolvedLink {
  /** direct: play the link itself; stream: play `url`; playlist: `entries`; page / failed: `problem` */
  kind: 'direct' | 'stream' | 'playlist' | 'page' | 'failed'
  /** what the <video> loads (the link itself for `direct`) */
  url: string
  /** how: a media file, an HLS or DASH manifest, one progressive file */
  route: 'file' | 'hls' | 'dash' | 'progressive' | null
  title: string | null
  duration: number | null
  thumbnail: string | null
  /** the site, as a domain ("youtube.com") */
  site: string | null
  live: boolean
  problem: LinkProblem | null
  /** yt-dlp's own sentence, shortened (for `error`) */
  message: string | null
  entries: LinkEntry[]
}

const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'mov',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'ogv',
  '3gp',
  'm3u8',
  'mpd',
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'm4a',
  'aac',
  'wma',
  'mka',
])

/**
 * A link that already is media (by its path's extension, or a streaming scheme): it plays as
 * it is, no yt-dlp. `…/watch?v=…` and other pages are not.
 */
export function isDirectMediaUrl(url: string): boolean {
  const text = url.trim()
  if (/^(rtsp|rtmp|rtmps|mms):\/\//i.test(text)) return true
  let path: string
  try {
    path = new URL(text).pathname
  } catch {
    return false
  }
  const last = path.slice(path.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return false
  return MEDIA_EXTENSIONS.has(last.slice(dot + 1).toLowerCase())
}

/** "youtube.com" for a link (the www. dropped); the text itself when it is not a URL. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** A link opens in a browser or mpv only when it is http(s). */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim())
}

/** Links in dropped or pasted text: one per line (`text/uri-list` comments skipped). */
export function linksInText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && /^(https?|rtsp|rtmp):\/\/\S+$/i.test(l))
}

/** How long a resolved stream URL is trusted before asking yt-dlp again (YouTube's last ~6 h). */
export const LINK_TTL_MS = 60 * 60 * 1000

/** The answer for a link that plays as it is (no need to ask the core). */
export function directLink(url: string, route: ResolvedLink['route'] = 'file'): ResolvedLink {
  return {
    kind: 'direct',
    url,
    route,
    title: null,
    duration: null,
    thumbnail: null,
    site: linkHost(url),
    live: false,
    problem: null,
    message: null,
    entries: [],
  }
}

/** The answer when asking failed outright (the core did not answer). */
export function failedLink(url: string, message: string): ResolvedLink {
  return { ...directLink(url), kind: 'failed', route: null, problem: 'error', message }
}
