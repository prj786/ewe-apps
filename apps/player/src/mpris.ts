// The webview's side of MPRIS: coalesce state pushes to the Rust server.
import { mprisUpdate, type MprisUpdate } from './bridge'

let pending: MprisUpdate | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  timer = null
  const u = pending
  pending = null
  if (u !== null) void mprisUpdate(u).catch(() => undefined)
}

/** Merge into the next push (sent within 80 ms); seeks and status changes go at once. */
export function publish(update: MprisUpdate, urgent = false): void {
  pending = { ...(pending ?? {}), ...update }
  if (urgent) {
    if (timer !== null) clearTimeout(timer)
    flush()
    return
  }
  timer ??= setTimeout(flush, 80)
}
