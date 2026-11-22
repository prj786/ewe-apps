/** The core's loopback media server: where the webview fetches raw files, thumbnails and covers. */
export interface MediaServer {
  port: number
  token: string
}

export type ThumbSize = 128 | 256 | 512

function origin(server: MediaServer): string {
  return `http://127.0.0.1:${server.port}`
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash === -1 ? path : path.slice(slash + 1)
  return name === '' ? 'file' : name
}

/** `http://127.0.0.1:<port>/raw/<name>?path=…&t=…` — ends in the file name so viewers show it. */
export function rawUrl(server: MediaServer, path: string): string {
  const params = new URLSearchParams({ path, t: server.token })
  return `${origin(server)}/raw/${encodeURIComponent(baseName(path))}?${params.toString()}`
}

/**
 * The smallest thumbnail the core serves that covers `px` device pixels (a 126 px tile at
 * scale 1.8 wants 227 → 256; past 512 the 512 one is scaled up).
 */
export function thumbSizeFor(px: number): ThumbSize {
  return px <= 128 ? 128 : px <= 256 ? 256 : 512
}

export function thumbUrl(server: MediaServer, path: string, size: ThumbSize = 256): string {
  const params = new URLSearchParams({ path, size: String(size), t: server.token })
  return `${origin(server)}/thumb?${params.toString()}`
}

/**
 * The icon embedded in an eep card (`<Name>.eep`): a PNG or SVG, as the card has it.
 * `mtime` is in the URL so an updated card shows its new icon.
 */
export function appIconUrl(server: MediaServer, path: string, mtime: number): string {
  const params = new URLSearchParams({ path, m: String(mtime), t: server.token })
  return `${origin(server)}/app-icon?${params.toString()}`
}

export function coverUrl(server: MediaServer, path: string): string {
  const params = new URLSearchParams({ path, t: server.token })
  return `${origin(server)}/cover?${params.toString()}`
}

/** Pictures WebKitGTK cannot decode (HEIC/HEIF from phones): the core converts them. */
export function needsPictureConversion(path: string): boolean {
  return /\.(heic|heif|hif)$/i.test(path)
}

/**
 * What an `<img>` shows a picture from: the raw file, or for HEIC/HEIF a JPEG the core
 * makes once and caches (`/picture/<name>`).
 */
export function pictureUrl(server: MediaServer, path: string): string {
  if (!needsPictureConversion(path)) return rawUrl(server, path)
  const params = new URLSearchParams({ path, t: server.token })
  return `${origin(server)}/picture/${encodeURIComponent(baseName(path))}.jpg?${params.toString()}`
}
