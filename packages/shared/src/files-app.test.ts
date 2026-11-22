import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BATCH_RENAME,
  batchRenameNames,
  cardFileName,
  cardStem,
  isExecutable,
  joinPath,
  modeFromTriplets,
  modeText,
  modeTriplets,
  parentOf,
  uniqueName,
} from './files-app'

describe('paths', () => {
  it('joins and splits', () => {
    expect(joinPath('/', 'a')).toBe('/a')
    expect(joinPath('/x', 'a')).toBe('/x/a')
    expect(parentOf('/x/a')).toBe('/x')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBeNull()
  })

  it('picks unique names', () => {
    expect(uniqueName(['New folder'], 'New folder')).toBe('New folder 2')
    expect(uniqueName(['New folder', 'New folder 2'], 'New folder')).toBe('New folder 3')
    expect(uniqueName([], 'x')).toBe('x')
  })
})

describe('modes', () => {
  it('renders and rebuilds', () => {
    expect(modeText(0o754)).toBe('rwxr-xr--')
    expect(modeTriplets(0o754)).toEqual([7, 5, 4])
    expect(modeFromTriplets([7, 5, 4], 0o4000)).toBe(0o4754)
    expect(isExecutable({ mode: 0o755, dir: false })).toBe(true)
    expect(isExecutable({ mode: 0o644, dir: false })).toBe(false)
    expect(isExecutable({ mode: 0o755, dir: true })).toBe(false)
  })
})

describe('batch rename', () => {
  const files = [
    { name: 'IMG_001.jpg', dir: false },
    { name: 'IMG_002.jpg', dir: false },
    { name: 'Holiday', dir: true },
  ]

  it('finds and replaces, keeps extensions', () => {
    expect(
      batchRenameNames(files, { ...DEFAULT_BATCH_RENAME, find: 'IMG_', replace: 'Rome ' }),
    ).toEqual(['Rome 001.jpg', 'Rome 002.jpg', 'Holiday'])
  })

  it('numbers, prefixes, suffixes and changes case', () => {
    expect(
      batchRenameNames(files, {
        ...DEFAULT_BATCH_RENAME,
        numberStart: 5,
        numberDigits: 2,
        prefix: 'x-',
        suffix: '-y',
        case: 'lower',
      }),
    ).toEqual(['x-img_001 05-y.jpg', 'x-img_002 06-y.jpg', 'x-holiday 07-y'])
    expect(
      batchRenameNames([{ name: 'photo {n}.png', dir: false }], {
        ...DEFAULT_BATCH_RENAME,
        numberStart: 1,
        numberDigits: 3,
      }),
    ).toEqual(['photo 001.png'])
    expect(
      batchRenameNames([{ name: 'my summer-trip_photos.jpg', dir: false }], {
        ...DEFAULT_BATCH_RENAME,
        case: 'title',
      }),
    ).toEqual(['My Summer-Trip_Photos.jpg'])
  })
})

describe('eep cards', () => {
  it('keeps .eep on a renamed card', () => {
    expect(cardStem('Firefox.eep')).toBe('Firefox')
    expect(cardStem('Firefox.EEP')).toBe('Firefox')
    expect(cardFileName('Web')).toBe('Web.eep')
    expect(cardFileName(' Web.eep ')).toBe('Web.eep')
    expect(cardFileName('my.app')).toBe('my.app.eep')
  })
})
