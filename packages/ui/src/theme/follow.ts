import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ThemeTokens } from '@ewe/shared'
import { applyTheme, type ThemeMode } from './apply'
import { parseEweTokens } from './parse'

/** Ask the core for the current theme-tokens.json (null when there is none). */
export async function fetchTheme(): Promise<ThemeTokens | null> {
  try {
    const raw = await invoke<unknown>('theme_tokens')
    return parseEweTokens(raw)
  } catch {
    return null
  }
}

/**
 * Apply the live ewe theme now and on every change (the core watches the
 * tokens file and emits `theme-changed`). Returns a stop function. The first
 * paint already matches: call it before rendering.
 */
export function followTheme(
  mode: () => ThemeMode = () => 'system',
  onTheme?: (theme: ThemeTokens | null) => void,
): () => void {
  let stopped = false
  let pushed = false
  let unlisten: (() => void) | null = null
  const apply = (theme: ThemeTokens | null) => {
    applyTheme(theme, mode())
    onTheme?.(theme)
  }
  void listen<unknown>('theme-changed', (event) => {
    if (stopped) return
    pushed = true
    apply(parseEweTokens(event.payload))
  }).then((off) => {
    if (stopped) off()
    else unlisten = off
  })
  void fetchTheme().then((theme) => {
    if (!stopped && !pushed) apply(theme)
  })
  return () => {
    stopped = true
    unlisten?.()
  }
}
