import type { Point, Rect, Size } from './models'

/** the side of its element a tooltip opens on */
export type TipSide = 'above' | 'below' | 'right' | 'left'

/** between the element and its tooltip */
export const TIP_GAP = 4
/** between a tooltip and the window's edge */
export const TIP_MARGIN = 4

const OPPOSITE: Record<TipSide, TipSide> = {
  above: 'below',
  below: 'above',
  right: 'left',
  left: 'right',
}

export function isTipSide(text: string): text is TipSide {
  return text in OPPOSITE
}

/** room for a tooltip between `anchor` and the edge of `bounds` on one side */
function room(anchor: Rect, bounds: Rect, side: TipSide, gap: number, margin: number): number {
  switch (side) {
    case 'above':
      return anchor.y - gap - margin - bounds.y
    case 'below':
      return bounds.y + bounds.height - margin - gap - (anchor.y + anchor.height)
    case 'left':
      return anchor.x - gap - margin - bounds.x
    case 'right':
      return bounds.x + bounds.width - margin - gap - (anchor.x + anchor.width)
  }
}

/** `start`, moved as little as it takes to keep `size` inside `from … from + extent` */
function slide(start: number, size: number, from: number, extent: number, margin: number): number {
  const last = from + extent - margin - size
  return Math.max(from + margin, Math.min(start, last))
}

/**
 * Where a tooltip of `size` goes for the element `anchor` so that all of it is
 * inside `bounds` (the window): on the side asked for when it fits there, else on
 * the opposite side, else on whichever of the two has more room; centred on the
 * element, then moved along the edge as little as it takes to stay inside. A
 * tooltip larger than the window starts at the window's top left margin.
 */
export function placeTooltip(
  anchor: Rect,
  size: Size,
  bounds: Rect,
  prefer: TipSide = 'above',
  gap = TIP_GAP,
  margin = TIP_MARGIN,
): Point & { side: TipSide } {
  const vertical = prefer === 'above' || prefer === 'below'
  const need = vertical ? size.height : size.width
  const other = OPPOSITE[prefer]
  const here = room(anchor, bounds, prefer, gap, margin)
  const there = room(anchor, bounds, other, gap, margin)
  const side = here >= need ? prefer : there >= need ? other : here >= there ? prefer : other

  let x: number
  let y: number
  if (side === 'above' || side === 'below') {
    x = anchor.x + anchor.width / 2 - size.width / 2
    y = side === 'above' ? anchor.y - gap - size.height : anchor.y + anchor.height + gap
  } else {
    x = side === 'left' ? anchor.x - gap - size.width : anchor.x + anchor.width + gap
    y = anchor.y + anchor.height / 2 - size.height / 2
  }
  return {
    x: Math.round(slide(x, size.width, bounds.x, bounds.width, margin)),
    y: Math.round(slide(y, size.height, bounds.y, bounds.height, margin)),
    side,
  }
}
