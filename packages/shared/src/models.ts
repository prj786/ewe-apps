export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export type ThemeVariant = 'dark' | 'light'

/** The ewe theme as the webview applies it: CSS custom properties by name. */
export interface ThemeTokens {
  source: 'ewe'
  variant: ThemeVariant
  name: string
  /** colours and shadows — only applied when the app follows the ewe scheme */
  vars: Record<string, string>
  /** shape, size (× text scale), fonts, weights and motion — always applied */
  base: Record<string, string>
}
