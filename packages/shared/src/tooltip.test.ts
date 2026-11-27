import { describe, expect, it } from 'vitest'
import { TIP_GAP, TIP_MARGIN, isTipSide, placeTooltip } from './tooltip'

const win = { x: 0, y: 0, width: 320, height: 200 }
const size = { width: 120, height: 24 }

/** every edge of the tooltip is inside the window, a margin away from its edges */
function inside(at: { x: number; y: number }, s = size, b = win): boolean {
  return (
    at.x >= b.x + TIP_MARGIN &&
    at.y >= b.y + TIP_MARGIN &&
    at.x + s.width <= b.x + b.width - TIP_MARGIN &&
    at.y + s.height <= b.y + b.height - TIP_MARGIN
  )
}

describe('placeTooltip', () => {
  it('opens above, centred on its element, when there is room', () => {
    const at = placeTooltip({ x: 140, y: 100, width: 40, height: 28 }, size, win)
    expect(at).toEqual({ x: 100, y: 100 - TIP_GAP - 24, side: 'above' })
  })

  it('opens below an element at the top of the window', () => {
    const at = placeTooltip({ x: 140, y: 6, width: 40, height: 28 }, size, win)
    expect(at.side).toBe('below')
    expect(at.y).toBe(6 + 28 + TIP_GAP)
  })

  it('goes back above when the side asked for has no room', () => {
    const at = placeTooltip({ x: 140, y: 168, width: 40, height: 28 }, size, win, 'below')
    expect(at.side).toBe('above')
    expect(inside(at)).toBe(true)
  })

  it('stays inside the left edge: the places button, the first of a toolbar', () => {
    const at = placeTooltip({ x: 4, y: 100, width: 28, height: 28 }, size, win)
    expect(at.x).toBe(TIP_MARGIN)
    expect(inside(at)).toBe(true)
  })

  it('stays inside the right edge: the last button of a toolbar', () => {
    const at = placeTooltip({ x: 288, y: 100, width: 28, height: 28 }, size, win)
    expect(at.x).toBe(320 - TIP_MARGIN - 120)
    expect(inside(at)).toBe(true)
  })

  it('opens beside a rail, and on the other side when the window ends there', () => {
    const rail = { x: 8, y: 60, width: 40, height: 40 }
    expect(placeTooltip(rail, size, win, 'right')).toEqual({
      x: 8 + 40 + TIP_GAP,
      y: 60 + 20 - 12,
      side: 'right',
    })
    const far = { x: 272, y: 60, width: 40, height: 40 }
    const at = placeTooltip(far, size, win, 'right')
    expect(at.side).toBe('left')
    expect(inside(at)).toBe(true)
  })

  it('is inside in every corner, on every side asked for', () => {
    const corners = [
      { x: 0, y: 0, width: 24, height: 24 },
      { x: 296, y: 0, width: 24, height: 24 },
      { x: 0, y: 176, width: 24, height: 24 },
      { x: 296, y: 176, width: 24, height: 24 },
    ]
    for (const anchor of corners)
      for (const side of ['above', 'below', 'left', 'right'] as const)
        expect(inside(placeTooltip(anchor, size, win, side))).toBe(true)
  })

  it('takes the side with more room when it fits on neither', () => {
    const tall = { width: 120, height: 150 }
    const at = placeTooltip({ x: 100, y: 120, width: 40, height: 28 }, tall, win)
    expect(at.side).toBe('above')
    expect(inside(at, tall)).toBe(true)
  })

  it('answers to bounds that do not start at the corner (a sized shot)', () => {
    const box = { x: 100, y: 50, width: 240, height: 200 }
    const at = placeTooltip({ x: 104, y: 56, width: 28, height: 28 }, size, box)
    expect(at).toEqual({ x: 100 + TIP_MARGIN, y: 56 + 28 + TIP_GAP, side: 'below' })
  })

  it('starts at the top left margin when it is larger than the window', () => {
    const huge = { width: 400, height: 300 }
    const at = placeTooltip({ x: 140, y: 100, width: 40, height: 28 }, huge, win)
    expect(at.x).toBe(TIP_MARGIN)
    expect(at.y).toBe(TIP_MARGIN)
  })
})

describe('isTipSide', () => {
  it('knows the four sides and nothing else', () => {
    expect(['above', 'below', 'left', 'right'].every(isTipSide)).toBe(true)
    expect(isTipSide('')).toBe(false)
    expect(isTipSide('top')).toBe(false)
  })
})
