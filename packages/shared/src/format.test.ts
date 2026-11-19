import { describe, expect, it } from 'vitest'
import { dayLabel, formatBytes, formatTimeSpan, timeAgo } from './format'

describe('format', () => {
  it('formats bytes in decimal units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(120_000_000)).toBe('120 MB')
  })

  it('formats durations in words', () => {
    expect(formatTimeSpan(5)).toBe('5s')
    expect(formatTimeSpan(0.2)).toBe('1s')
    expect(formatTimeSpan(120)).toBe('2 min')
    expect(formatTimeSpan(3600 * 2 + 60 * 5)).toBe('2 h 5 min')
    expect(formatTimeSpan(-1)).toBe('')
  })

  it('labels days and relative times', () => {
    const now = new Date(2026, 10, 19, 12, 0, 0).getTime()
    expect(dayLabel(now, now)).toBe('Today')
    expect(dayLabel(now - 86_400_000, now)).toBe('Yesterday')
    expect(timeAgo(now - 30_000, now)).toBe('Just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2 h ago')
  })
})
