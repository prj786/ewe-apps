import type { ThemeTokens } from '@ewe/shared'

/** `system` follows the ewe scheme; `dark` / `light` force the built-in fallbacks' variant. */
export type ThemeMode = 'system' | 'dark' | 'light'

let appliedVars: string[] = []

/**
 * Put the tokens on `:root`. `base` (shape, sizes, fonts, motion) is always
 * applied when ewe tokens exist; colours and shadows only in `system` mode, so a
 * forced light or dark keeps the person's text size and motion speed.
 * `data-theme` follows the ewe variant (or the forced mode).
 */
export function applyTheme(theme: ThemeTokens | null, mode: ThemeMode = 'system'): void {
  const root = document.documentElement
  const followEwe = mode === 'system' && theme !== null
  if (mode === 'system') {
    if (theme !== null) root.dataset.theme = theme.variant
    else delete root.dataset.theme
  } else {
    root.dataset.theme = mode
  }
  for (const name of appliedVars) root.style.removeProperty(name)
  appliedVars = []
  if (theme !== null) {
    const vars = followEwe ? { ...theme.base, ...theme.vars } : theme.base
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
      appliedVars.push(name)
    }
  }
}
