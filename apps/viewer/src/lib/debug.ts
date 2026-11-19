// Errors, rejections and console warnings go to the process' stderr through the core,
// so `scripts/shot.sh … .log` tells why a document did not open.
import { invoke } from '@tauri-apps/api/core'

function send(level: string, message: string): void {
  void invoke('debug_log', { level, message: message.slice(0, 4000) }).catch(() => undefined)
}

const format = (args: unknown[]): string =>
  args
    .map((a) =>
      a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a),
    )
    .join(' ')

function safeJson(a: unknown): string {
  try {
    return JSON.stringify(a) ?? String(a)
  } catch {
    return String(a)
  }
}

export function forwardErrors(): void {
  window.addEventListener('error', (e) => send('error', `${e.message} (${e.filename}:${e.lineno})`))
  window.addEventListener('unhandledrejection', (e) => send('rejection', format([e.reason])))
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      send(level, format(args))
    }
  }
}
