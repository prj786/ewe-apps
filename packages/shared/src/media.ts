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

export function coverUrl(server: MediaServer, path: string): string {
  const params = new URLSearchParams({ path, t: server.token })
  return `${origin(server)}/cover?${params.toString()}`
}
