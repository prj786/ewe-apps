import type { ThemeTokens, ThemeVariant } from '@ewe/shared'

// The v3 theme-tokens.json (~/.config/quickshell/theme-tokens.json, written by
// `ewe-theme build`) → CSS custom properties. The same mapping as ewe Browser's
// main/ewe-theme.ts, so the apps and the browser wear the same values.

interface Shadow {
  x: number
  y: number
  blur: number
  color: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `#AARRGGBB` (Qt order, what ewe-theme writes) → `rgba()`; anything else passes through. */
export function cssColor(value: string): string {
  const hex = value.trim()
  if (/^#[0-9a-f]{8}$/i.test(hex)) {
    const a = parseInt(hex.slice(1, 3), 16) / 255
    const r = parseInt(hex.slice(3, 5), 16)
    const g = parseInt(hex.slice(5, 7), 16)
    const b = parseInt(hex.slice(7, 9), 16)
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
  }
  return hex
}

function cssShadow(value: unknown): string | null {
  if (!isObject(value)) return null
  const { x, y, blur, color } = value as Partial<Shadow>
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof blur !== 'number' ||
    typeof color !== 'string'
  )
    return null
  return `${x}px ${y}px ${blur}px ${cssColor(color)}`
}

const EASINGS: Record<string, string> = {
  Linear: 'linear',
  OutCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
  InOutCubic: 'cubic-bezier(0.65, 0, 0.35, 1)',
  OutQuad: 'cubic-bezier(0.5, 1, 0.89, 1)',
  InOutQuad: 'cubic-bezier(0.45, 0, 0.55, 1)',
  OutQuart: 'cubic-bezier(0.25, 1, 0.5, 1)',
  OutQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  OutExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  OutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
}

const TOKEN_KEY = /^[a-z0-9-]+$/
const FONT_CSS = /^[\w\s"',.-]+$/

/**
 * Faces for the scripts Geist has no glyphs for, all from `noto-fonts` (an ewe package).
 * Without them WebKitGTK resolves `system-ui` through fontconfig, which on Arch picks GNU
 * FreeFont (FreeMono!) for Arabic: unjoined letters in a typewriter face. CJK is left to
 * fontconfig (Source Han Sans, the regional cut by language).
 */
export const SCRIPT_FONTS: readonly string[] = [
  'Noto Sans Arabic UI',
  'Noto Sans Hebrew',
  'Noto Sans Georgian',
  'Noto Sans Armenian',
  'Noto Sans Devanagari UI',
  'Noto Sans Bengali UI',
  'Noto Sans Gurmukhi UI',
  'Noto Sans Gujarati UI',
  'Noto Sans Tamil UI',
  'Noto Sans Telugu UI',
  'Noto Sans Kannada UI',
  'Noto Sans Malayalam UI',
  'Noto Sans Sinhala UI',
  'Noto Sans Thai',
  'Noto Sans Lao',
  'Noto Sans Khmer',
  'Noto Sans Myanmar',
  'Noto Sans Ethiopic',
]

const GENERIC_FONTS = new Set([
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
])

/**
 * The face tried right after the first one, before the script faces: Noto Sans (or its
 * Mono) has Latin, Greek, Cyrillic and the spaces and punctuation Geist lacks — the
 * narrow no-break space ICU puts in "5:45 PM", for one. WebKit looks for a missing
 * character family by family and opens each font file on the way, so without this
 * every list of dates opened all eighteen script faces before `system-ui` gave it
 * Noto Sans anyway (strace, 2026-11-23: 190 font files opened while a window started).
 */
export const LATIN_FALLBACK = { sans: 'Noto Sans', mono: 'Noto Sans Mono' } as const

/**
 * A font stack with LATIN_FALLBACK after its first family and SCRIPT_FONTS before its
 * first generic family (none twice).
 */
export function withScriptFonts(stack: string): string {
  const families = stack
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '')
  const plain = (f: string) => f.replace(/^["']|["']$/g, '').toLowerCase()
  const have = new Set(families.map(plain))
  const mono = families.some((f) => /mono/i.test(f))
  const latin = mono ? LATIN_FALLBACK.mono : LATIN_FALLBACK.sans
  const lead = have.has(latin.toLowerCase()) || families.length === 0 ? [] : [`"${latin}"`]
  const extra = SCRIPT_FONTS.filter((f) => !have.has(f.toLowerCase())).map((f) => `"${f}"`)
  const first = families.length > 0 && !GENERIC_FONTS.has(plain(families[0] ?? '')) ? 1 : 0
  const rest = families.slice(first)
  const at = rest.findIndex((f) => GENERIC_FONTS.has(plain(f)))
  const cut = at === -1 ? rest.length : at
  return [
    ...families.slice(0, first),
    ...lead,
    ...rest.slice(0, cut),
    ...extra,
    ...rest.slice(cut),
  ].join(', ')
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`
}

function baseVars(parsed: Record<string, unknown>): Record<string, string> {
  const base: Record<string, string> = {}
  const access = isObject(parsed.accessibility) ? parsed.accessibility : {}
  const scale = (num(access.text_scale) ?? 100) / 100
  const textScale = scale >= 0.5 && scale <= 3 ? scale : 1
  if (isObject(parsed.shape)) {
    for (const [key, value] of Object.entries(parsed.shape)) {
      const n = num(value)
      if (n !== null && n >= 0 && TOKEN_KEY.test(key)) base[`--${key}`] = px(n)
    }
  }
  if (isObject(parsed.size)) {
    for (const [key, value] of Object.entries(parsed.size)) {
      const n = num(value)
      if (n === null || n < 0 || !TOKEN_KEY.test(key)) continue
      const text = key.startsWith('font-size-') || key.startsWith('line-height-')
      base[`--${key}`] = px(text ? n * textScale : n)
    }
  }
  if (isObject(parsed.type)) {
    const css = isObject(parsed.type.css) ? parsed.type.css : {}
    if (typeof css.sans === 'string' && FONT_CSS.test(css.sans))
      base['--font-sans'] = withScriptFonts(css.sans)
    if (typeof css.mono === 'string' && FONT_CSS.test(css.mono))
      base['--font-mono'] = withScriptFonts(css.mono)
    if (isObject(parsed.type.weight)) {
      for (const [key, value] of Object.entries(parsed.type.weight)) {
        const n = num(value)
        if (n !== null && TOKEN_KEY.test(key)) base[`--${key}`] = String(n)
      }
    }
  }
  if (isObject(parsed.motion)) {
    const motion = parsed.motion
    const speed = num(motion.speed) ?? 1
    const reduce = motion.reduceMotion === true || access.reduce_motion === true
    const dur = (value: unknown): string | null => {
      const n = num(value)
      if (n === null || n < 0) return null
      return reduce ? '1ms' : `${Math.round(n / (speed > 0 ? speed : 1))}ms`
    }
    const fast = dur(motion.durFast)
    const baseDur = dur(motion.durBase)
    const slow = dur(motion.durSlow)
    if (fast !== null) base['--dur-fast'] = fast
    if (baseDur !== null) base['--dur-base'] = baseDur
    if (slow !== null) base['--dur-slow'] = slow
    const easing = isObject(motion.easing) ? motion.easing : {}
    const out = typeof easing.base === 'string' ? EASINGS[easing.base] : undefined
    const inOut = typeof easing.slow === 'string' ? EASINGS[easing.slow] : undefined
    if (out !== undefined) base['--ease-out'] = out
    if (inOut !== undefined) base['--ease-in-out'] = inOut
  }
  return base
}

/** The parsed JSON (an object) → ThemeTokens, or null when it is not a v3 token file. */
export function parseEweTokens(parsed: unknown): ThemeTokens | null {
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return null
    }
  }
  if (!isObject(parsed) || parsed.version !== 3 || !isObject(parsed.color)) return null
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.color)) {
    if (typeof value === 'string' && TOKEN_KEY.test(key)) vars[`--${key}`] = cssColor(value)
  }
  if (isObject(parsed.shadow)) {
    for (const [key, value] of Object.entries(parsed.shadow)) {
      const shadow = cssShadow(value)
      if (shadow !== null && TOKEN_KEY.test(key)) vars[`--${key}`] = shadow
    }
  }
  const scheme = isObject(parsed.scheme) ? parsed.scheme : {}
  const input = isObject(parsed.input) ? parsed.input : {}
  const variantRaw = scheme.variant ?? input.variant
  const variant: ThemeVariant = variantRaw === 'light' ? 'light' : 'dark'
  const name = typeof scheme.name === 'string' ? scheme.name : 'Ewe'
  return { source: 'ewe', variant, name, vars, base: baseVars(parsed) }
}
