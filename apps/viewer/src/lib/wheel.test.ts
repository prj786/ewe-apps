import { describe, expect, it } from 'vitest'
import { isNotch, smoothZoomFactor, wheelStepper } from './wheel'

const ev = (deltaY: number, timeStamp: number, deltaMode = 0) => ({ deltaY, deltaMode, timeStamp })

describe('wheelStepper', () => {
  it('takes one step per notch of a mouse wheel', () => {
    const step = wheelStepper()
    expect(step(ev(120, 0))).toBe(1)
    expect(step(ev(120, 30))).toBe(1)
    expect(step(ev(-53, 60))).toBe(-1)
    expect(step(ev(3, 90, 1))).toBe(1) // lines
    expect(isNotch(ev(4, 0))).toBe(false)
  })

  it('takes one step per stretch of a touchpad swipe, not one per event', () => {
    const step = wheelStepper({ threshold: 60 })
    let steps = 0
    // 40 events of 6 px = 240 px travelled
    for (let i = 0; i < 40; i++) steps += step(ev(6, i * 8))
    expect(steps).toBe(4)
  })

  it('turns one page per swipe when asked to step once', () => {
    const flip = wheelStepper({ threshold: 60, once: true })
    let pages = 0
    for (let i = 0; i < 60; i++) pages += flip(ev(8, i * 8))
    expect(pages).toBe(1)
    // the fingers rested: the next swipe turns the next page
    for (let i = 0; i < 20; i++) pages += flip(ev(8, 1000 + i * 8))
    expect(pages).toBe(2)
  })

  it('starts over when the direction turns', () => {
    const step = wheelStepper({ threshold: 60 })
    for (let i = 0; i < 9; i++) expect(step(ev(6, i * 8))).toBe(0) // 54 px down
    for (let i = 0; i < 9; i++) expect(step(ev(-6, 80 + i * 8))).toBe(0) // 54 px up: no step
    expect(step(ev(-8, 160))).toBe(-1)
  })
})

describe('smoothZoomFactor', () => {
  it('zooms in when the swipe goes up and back out by the same', () => {
    expect(smoothZoomFactor(-10)).toBeGreaterThan(1)
    expect(smoothZoomFactor(10)).toBeLessThan(1)
    expect(smoothZoomFactor(-10) * smoothZoomFactor(10)).toBeCloseTo(1)
    expect(smoothZoomFactor(0)).toBe(1)
  })
})
