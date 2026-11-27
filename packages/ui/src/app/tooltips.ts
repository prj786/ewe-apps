import { TIP_MARGIN, isTipSide, placeTooltip, type TipSide } from '@ewe/shared'

/**
 * The hints of the whole window (`data-tooltip`, the `Tooltip` wrapper, every
 * `IconButton`): ONE bubble, placed by measuring, so all of it is inside the window.
 *
 * It used to be each element's own `::after`, centred over the element. That box
 * is part of the page's layout: at a window's edge it ran out of the window, and
 * inside anything that scrolls (a tab strip, the places drawer) it was cut. Small
 * tiles made that the usual case, not the rare one.
 *
 * The side a hint opens on is CSS: `--tip-side: above | below | left | right` on
 * the element (components.css puts the bars' hints below them). When that side has
 * no room the bubble takes the other one (`placeTooltip` in @ewe/shared).
 *
 * Call it once, before the app renders.
 */
export function installTooltips(): void {
  if (installed) return
  installed = true
  // hover: after the theme's delay, on the element under the pointer
  document.addEventListener('mouseover', (e) => {
    const el = holder(e.target)
    if (el !== dismissed) dismissed = null
    if (el === anchor || el === waiting || el === dismissed) return
    hide()
    if (el !== null) later(el)
  })
  // the pointer left the window (there is no next element)
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget === null) hide()
  })
  // the keyboard: at once, as the `:focus-visible` rule did
  document.addEventListener('focusin', (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (el?.matches('[data-tooltip]:focus-visible') === true) {
      hide()
      show(el)
    }
  })
  document.addEventListener('focusout', hide)
  // anything the user does ends a hint: it must never cover what they act on, and
  // what it pointed at may be gone after it. It stays away until the pointer has
  // been somewhere else (a pressed button does not explain itself again)
  for (const type of ['mousedown', 'keydown', 'wheel', 'dragstart', 'contextmenu'])
    document.addEventListener(type, dismiss, { capture: true, passive: true })
  document.addEventListener('scroll', hide, { capture: true, passive: true })
  window.addEventListener('blur', hide)
  window.addEventListener('resize', hide)
}

let installed = false
/** the element whose hint is showing */
let anchor: Element | null = null
/** the element whose hint will show when the delay is over */
let waiting: Element | null = null
/** the element whose hint the user ended by doing something */
let dismissed: Element | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let watch: ReturnType<typeof setInterval> | undefined
let bubble: HTMLDivElement | null = null

function holder(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-tooltip]') : null
}

/** `--tooltip-delay` in ms: the tokens write `500ms`, a theme may write seconds */
function delay(): number {
  const text = getComputedStyle(document.documentElement).getPropertyValue('--tooltip-delay').trim()
  const n = Number.parseFloat(text)
  if (!Number.isFinite(n)) return 500
  return /\d\s*s$/.test(text) && !text.endsWith('ms') ? n * 1000 : n
}

function later(el: Element): void {
  waiting = el
  timer = setTimeout(() => {
    waiting = null
    show(el)
  }, delay())
}

function dismiss(): void {
  dismissed = anchor ?? waiting ?? dismissed
  hide()
}

function hide(): void {
  clearTimeout(timer)
  clearInterval(watch)
  waiting = null
  anchor = null
  bubble?.classList.remove('show')
}

function show(el: Element): void {
  const text = el.getAttribute('data-tooltip') ?? ''
  if (text === '' || !el.isConnected) return
  // inside the app's root: a sized screenshot (`--shot-width`) keeps every fixed
  // layer in that box, and the root's box is the window everywhere else
  const root = el.closest('.app') ?? document.body
  bubble ??= Object.assign(document.createElement('div'), { className: 'tip-bubble' })
  bubble.setAttribute('role', 'tooltip')
  if (bubble.parentElement !== root) root.append(bubble)
  bubble.textContent = text
  // it has a box only while it shows (components.css): show it first, measure, place
  bubble.classList.add('show')
  const bounds = root.getBoundingClientRect()
  // as wide as its words, never wider than the window lets it be
  bubble.style.setProperty('--tip-room', `${Math.max(0, bounds.width - 2 * TIP_MARGIN)}px`)
  bubble.style.translate = 'none'
  // where `left: 0; top: 0` is on the screen, and how large the words came out
  const at0 = bubble.getBoundingClientRect()
  const side = getComputedStyle(el).getPropertyValue('--tip-side').trim()
  const prefer: TipSide = isTipSide(side) ? side : 'above'
  const rect = el.getBoundingClientRect()
  // an element that is not drawn (a hidden tab's button that kept the focus)
  if (rect.width === 0 && rect.height === 0) {
    bubble.classList.remove('show')
    return
  }
  const at = placeTooltip(
    { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    { width: at0.width, height: at0.height },
    { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
    prefer,
  )
  bubble.style.translate = `${at.x - at0.left}px ${at.y - at0.top}px`
  anchor = el
  // nothing tells the page that an element went away under a pointer at rest (an
  // operation ended and its button left the bar): look while the hint is up
  clearInterval(watch)
  watch = setInterval(() => {
    if (anchor === null || !anchor.isConnected || anchor.getAttribute('data-tooltip') !== text)
      hide()
  }, 300)
}
