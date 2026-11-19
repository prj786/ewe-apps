import { describe, expect, it } from 'vitest'
import { cssColor, parseEweTokens } from './parse'

const tokens = {
  version: 3,
  color: { 'surface-base': '#0b0a08', accent: '#ff112233', 'Bad Key': '#000' },
  shadow: { 'shadow-sm': { x: 0, y: 1, blur: 2, color: '#66020202' }, 'shadow-none': null },
  shape: { primary: 8, rounded: 10 },
  size: { 'font-size-md': 13, 'control-md': 28, 'line-height-md': 18 },
  type: {
    css: { sans: '"Geist", system-ui, sans-serif', mono: 'url(x)' },
    weight: { 'font-weight-medium': 500 },
  },
  motion: { durFast: 150, durBase: 200, durSlow: 250, speed: 2, easing: { base: 'OutCubic' } },
  accessibility: { text_scale: 130, reduce_motion: false },
  scheme: { name: 'Ewe Light', variant: 'light' },
}

describe('parseEweTokens', () => {
  it('maps colours, shadows, shape, size, fonts and motion to CSS vars', () => {
    const t = parseEweTokens(tokens)
    expect(t).not.toBeNull()
    if (t === null) return
    expect(t.variant).toBe('light')
    expect(t.name).toBe('Ewe Light')
    expect(t.vars['--surface-base']).toBe('#0b0a08')
    expect(t.vars['--accent']).toBe('rgba(17, 34, 51, 1.000)')
    expect(t.vars['--Bad Key']).toBeUndefined()
    expect(t.vars['--shadow-sm']).toBe('0px 1px 2px rgba(2, 2, 2, 0.400)')
    expect(t.base['--primary']).toBe('8px')
    expect(t.base['--control-md']).toBe('28px')
    expect(t.base['--font-size-md']).toBe('16.9px')
    expect(t.base['--line-height-md']).toBe('23.4px')
    expect(t.base['--font-sans']).toBe('"Geist", system-ui, sans-serif')
    expect(t.base['--font-mono']).toBeUndefined()
    expect(t.base['--font-weight-medium']).toBe('500')
    expect(t.base['--dur-fast']).toBe('75ms')
    expect(t.base['--ease-out']).toBe('cubic-bezier(0.33, 1, 0.68, 1)')
  })

  it('collapses motion to 1ms under reduce motion', () => {
    const t = parseEweTokens({
      ...tokens,
      accessibility: { reduce_motion: true },
    })
    expect(t?.base['--dur-base']).toBe('1ms')
  })

  it('accepts a JSON string and rejects other versions', () => {
    expect(parseEweTokens(JSON.stringify(tokens))?.variant).toBe('light')
    expect(parseEweTokens({ version: 2, color: {} })).toBeNull()
    expect(parseEweTokens('not json')).toBeNull()
    expect(parseEweTokens(null)).toBeNull()
  })

  it('converts Qt #AARRGGBB colours', () => {
    expect(cssColor('#80ff0000')).toBe('rgba(255, 0, 0, 0.502)')
    expect(cssColor('#eeb407')).toBe('#eeb407')
  })
})
