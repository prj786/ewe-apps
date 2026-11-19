// The position memory on disk: $XDG_DATA_HOME/ewe-viewer/positions.json, read once,
// written a moment after the last change.

import { storeRead, storeWrite } from './bridge'
import { loadMemory, positionOf, remember, type Memory, type Position } from './memory'

let memory: Memory | null = null
let loading: Promise<Memory> | null = null
let timer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<Memory> {
  if (memory !== null) return memory
  loading ??= storeRead('positions')
    .catch(() => null)
    .then((value) => {
      memory = loadMemory(value)
      return memory
    })
  return loading
}

export async function recallPosition(path: string): Promise<Position | null> {
  return positionOf(await load(), path)
}

export function savePosition(path: string, position: Omit<Position, 'at'>): void {
  void load().then((m) => {
    memory = remember(m, path, position)
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, 800)
  })
}

export function flush(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (memory !== null) void storeWrite('positions', memory).catch(() => undefined)
}

// quitting mid-debounce must not lose the last page
window.addEventListener('pagehide', flush)
window.addEventListener('beforeunload', flush)

/** Small app settings (night mode, sidebar, book theme…), same mechanism. */
const SETTINGS_KEY = 'ewe-viewer-settings'
export function getSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw === null) return fallback
    const all = JSON.parse(raw) as Record<string, unknown>
    return key in all ? (all[key] as T) : fallback
  } catch {
    return fallback
  }
}
export function setSetting(key: string, value: unknown): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const all = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)
    all[key] = value
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all))
  } catch {
    // no storage: the setting lives for this run only
  }
}
