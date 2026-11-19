// Where you left off, per file: page / zoom / mode for PDFs, a CFI for books, a page
// for comics, a scroll fraction for text. Pure: the store (lib/store.ts) does the I/O.

export interface Position {
  /** 1-based page (PDF, comic) */
  page?: number | undefined
  /** pdf.js scale value: 'page-width', 'page-fit', 'auto' or a number as a string */
  zoom?: string | undefined
  /** 'continuous' | 'single' | 'two' for PDFs; 'paged' | 'scrolled' for books */
  mode?: string | undefined
  /** rotation in degrees */
  rotation?: number | undefined
  /** book location (EPUB CFI) */
  cfi?: string | undefined
  /** 0–1 scroll fraction for long text */
  scroll?: number | undefined
  /** ms since the epoch, when it was last saved */
  at: number
}

export interface Memory {
  version: 1
  files: Record<string, Position>
}

export const EMPTY_MEMORY: Memory = { version: 1, files: {} }

/** Keep at most this many files; the oldest go first. */
export const MAX_REMEMBERED = 500

export function isMemory(value: unknown): value is Memory {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { version?: unknown; files?: unknown }
  return v.version === 1 && typeof v.files === 'object' && v.files !== null
}

export function loadMemory(value: unknown): Memory {
  return isMemory(value)
    ? { version: 1, files: { ...value.files } }
    : { ...EMPTY_MEMORY, files: {} }
}

export function positionOf(memory: Memory, path: string): Position | null {
  return memory.files[path] ?? null
}

/**
 * A new memory with `path` set to `position` (merged over what was there, so a view
 * that only knows the page keeps the saved zoom). Trims to MAX_REMEMBERED by age.
 */
export function remember(
  memory: Memory,
  path: string,
  position: Omit<Position, 'at'>,
  now = Date.now(),
): Memory {
  const previous = memory.files[path]
  const next: Position = { ...previous, ...stripUndefined(position), at: now }
  let files: Record<string, Position> = { ...memory.files, [path]: next }
  const keys = Object.keys(files)
  if (keys.length > MAX_REMEMBERED) {
    keys.sort((a, b) => (files[a]?.at ?? 0) - (files[b]?.at ?? 0))
    const drop = new Set(keys.slice(0, keys.length - MAX_REMEMBERED))
    files = Object.fromEntries(Object.entries(files).filter(([k]) => !drop.has(k)))
  }
  return { version: 1, files }
}

export function forget(memory: Memory, path: string): Memory {
  if (!(path in memory.files)) return memory
  return {
    version: 1,
    files: Object.fromEntries(Object.entries(memory.files).filter(([k]) => k !== path)),
  }
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v
  return out as T
}

/** pdf.js scale values we save: the named fits and numbers between 10 % and 1000 %. */
export function sanitizeZoom(zoom: string | undefined): string | undefined {
  if (zoom === undefined) return undefined
  if (zoom === 'page-width' || zoom === 'page-fit' || zoom === 'auto' || zoom === 'page-actual')
    return zoom
  const n = Number(zoom)
  if (!Number.isFinite(n) || n < 0.1 || n > 10) return undefined
  return String(Math.round(n * 1000) / 1000)
}
