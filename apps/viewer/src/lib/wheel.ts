// Wheel input comes in two kinds: a mouse wheel sends one large delta per notch, a
// touchpad sends a stream of small ones for one swipe (tens of events). Treating every
// event as a step made a two-finger swipe run a picture through all seventeen zoom
// steps, flip a comic a page per event and zoom a PDF to its limit.

/** What the helpers need of a WheelEvent (so tests need no DOM). */
export interface WheelLike {
  deltaY: number
  deltaMode: number
  timeStamp: number
}

/** One notch of a mouse wheel (not a touchpad's stream of small deltas). */
export function isNotch(e: WheelLike): boolean {
  return e.deltaMode !== 0 || Math.abs(e.deltaY) >= 30
}

/**
 * Turns wheel events into steps: a notch is one step; a touchpad swipe gives one step
 * per `threshold` px travelled — or, with `once`, a single step per swipe (a page
 * turn), until the swipe has been still for a moment.
 */
export function wheelStepper(
  options: { threshold?: number; once?: boolean } = {},
): (e: WheelLike) => -1 | 0 | 1 {
  const threshold = options.threshold ?? 60
  const once = options.once ?? false
  let travelled = 0
  let last = -Infinity
  let spent = false
  return (e) => {
    const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0
    if (dir === 0) return 0
    if (isNotch(e)) {
      travelled = 0
      spent = false
      last = e.timeStamp
      return dir
    }
    if (e.timeStamp - last > 180) {
      travelled = 0
      spent = false
    }
    last = e.timeStamp
    if (once && spent) return 0
    if (Math.sign(travelled) !== dir) travelled = 0
    travelled += e.deltaY
    if (Math.abs(travelled) < threshold) return 0
    travelled = 0
    spent = true
    return dir
  }
}

/** The zoom factor of one small touchpad delta: a 100 px swipe is about ×1.6. */
export function smoothZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0048)
}
