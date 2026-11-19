import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEMORY,
  MAX_REMEMBERED,
  forget,
  loadMemory,
  positionOf,
  remember,
  sanitizeZoom,
} from './memory'

describe('position memory', () => {
  it('loads only its own shape', () => {
    expect(loadMemory(null)).toEqual(EMPTY_MEMORY)
    expect(loadMemory({ version: 2, files: {} })).toEqual(EMPTY_MEMORY)
    expect(loadMemory('junk')).toEqual(EMPTY_MEMORY)
    const ok = { version: 1, files: { '/a.pdf': { page: 3, at: 1 } } }
    expect(loadMemory(ok)).toEqual(ok)
    expect(loadMemory(ok)).not.toBe(ok)
  })

  it('merges a partial position over the saved one', () => {
    let m = remember(EMPTY_MEMORY, '/a.pdf', { page: 4, zoom: 'page-width' }, 100)
    expect(positionOf(m, '/a.pdf')).toEqual({ page: 4, zoom: 'page-width', at: 100 })
    m = remember(m, '/a.pdf', { page: 9, zoom: undefined }, 200)
    expect(positionOf(m, '/a.pdf')).toEqual({ page: 9, zoom: 'page-width', at: 200 })
    expect(positionOf(m, '/b.pdf')).toBeNull()
  })

  it('does not mutate the previous memory', () => {
    const before = remember(EMPTY_MEMORY, '/a.pdf', { page: 1 }, 1)
    const after = remember(before, '/a.pdf', { page: 2 }, 2)
    expect(positionOf(before, '/a.pdf')?.page).toBe(1)
    expect(positionOf(after, '/a.pdf')?.page).toBe(2)
    expect(EMPTY_MEMORY.files).toEqual({})
  })

  it('drops the oldest files past the cap', () => {
    let m = EMPTY_MEMORY
    for (let i = 0; i < MAX_REMEMBERED + 10; i++) m = remember(m, `/f${i}.pdf`, { page: i }, i)
    expect(Object.keys(m.files)).toHaveLength(MAX_REMEMBERED)
    expect(positionOf(m, '/f0.pdf')).toBeNull()
    expect(positionOf(m, '/f9.pdf')).toBeNull()
    expect(positionOf(m, '/f10.pdf')?.page).toBe(10)
    expect(positionOf(m, `/f${MAX_REMEMBERED + 9}.pdf`)).not.toBeNull()
  })

  it('forgets', () => {
    const m = remember(EMPTY_MEMORY, '/a.pdf', { page: 1 }, 1)
    expect(forget(m, '/a.pdf').files).toEqual({})
    expect(forget(m, '/zzz')).toBe(m)
  })

  it('sanitizes zoom values', () => {
    expect(sanitizeZoom('page-width')).toBe('page-width')
    expect(sanitizeZoom('1.25')).toBe('1.25')
    expect(sanitizeZoom('1.23456')).toBe('1.235')
    expect(sanitizeZoom('0')).toBeUndefined()
    expect(sanitizeZoom('99')).toBeUndefined()
    expect(sanitizeZoom('huge')).toBeUndefined()
    expect(sanitizeZoom(undefined)).toBeUndefined()
  })
})
