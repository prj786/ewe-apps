import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BATCH_RENAME,
  activityBytes,
  activityFraction,
  appOrigin,
  appStanding,
  batchRenameNames,
  cardFileName,
  cardStem,
  deviceRoots,
  isExecutable,
  joinPath,
  listWindow,
  standingLabel,
  type EepActivity,
  modeFromTriplets,
  modeText,
  modeTriplets,
  parentOf,
  pathCrumbs,
  uniqueName,
  type Device,
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

describe('apps that are still installing', () => {
  const act = (patch: Partial<EepActivity> = {}): EepActivity => ({
    id: 'blender',
    name: 'Blender',
    card: '/home/you/Applications/Blender.eep',
    what: 'install',
    state: 'downloading',
    done: 430,
    total: 1000,
    download: 300,
    error: null,
    ...patch,
  })

  it('reads how a card stands', () => {
    // just dropped into Applications: eep has not begun
    expect(appStanding({ ready: false }, undefined)).toBe('waiting')
    expect(appStanding({ ready: false }, act({ state: 'waiting' }))).toBe('waiting')
    expect(appStanding({ ready: false }, act())).toBe('installing')
    expect(appStanding({ ready: false }, act({ state: 'finishing' }))).toBe('finishing')
    expect(appStanding({ ready: false }, act({ state: 'failed', error: 'x' }))).toBe('failed')
    // installed: it starts, whatever eep is doing to it
    expect(appStanding({ ready: true }, undefined)).toBe('ready')
    expect(appStanding({ ready: true }, act({ what: 'update' }))).toBe('updating')
    expect(appStanding({ ready: true }, act({ state: 'failed' }))).toBe('ready')
  })

  it('says how far it is', () => {
    expect(activityFraction(act())).toBeCloseTo(0.43)
    expect(activityFraction(act({ total: 0 }))).toBeNull()
    expect(activityFraction(act({ state: 'waiting' }))).toBeNull()
    expect(activityFraction(act({ state: 'finishing' }))).toBe(1)
    expect(activityFraction(act({ done: 2000 }))).toBe(1)
    expect(activityFraction(undefined)).toBeNull()
    expect(standingLabel('installing', act())).toBe('Installing 43%')
    expect(standingLabel('installing', act({ total: 0 }))).toBe('Installing…')
    expect(standingLabel('waiting', undefined)).toBe('Waiting…')
    expect(standingLabel('failed', act({ state: 'failed' }))).toBe('Not installed')
    expect(standingLabel('ready', undefined)).toBe('')
    expect(activityBytes(act())).toEqual({ done: 129, total: 300 })
    expect(activityBytes(act({ download: 0 }))).toBeNull()
  })

  it('names where a found app came from', () => {
    expect(appOrigin({ system: false, from: '' })).toBe('')
    expect(appOrigin({ system: true, from: 'pacman' })).toBe('Arch package')
    expect(appOrigin({ system: true, from: 'appimage' })).toBe('AppImage')
    expect(appOrigin({ system: true, from: '' })).toBe('On this computer')
  })
})

describe('windowed lists', () => {
  const grid = (scrollTop: number, extra: Partial<Parameters<typeof listWindow>[0]> = {}) =>
    listWindow({ total: 64, row: 124, cols: 8, scrollTop, viewport: 590, ...extra })

  it('renders the rows around the viewport', () => {
    expect(grid(0)).toEqual({ start: 0, end: 64, before: 0, after: 0 })
    const big = listWindow({ total: 3200, row: 124, cols: 8, scrollTop: 12400, viewport: 590 })
    // row 100 is at the top: two rows above it are kept, and 5 + 2 below
    expect(big.start).toBe(98 * 8)
    expect(big.before).toBe(98 * 124)
    expect(big.end).toBe((98 + 10) * 8)
    expect(big.before + ((big.end - big.start) / 8) * 124 + big.after).toBe(400 * 124)
  })

  it('is one answer per scroll position (0.3.1 froze: it depended on the rendered rows)', () => {
    // every position of a real Applications folder: asking again changes nothing
    for (let top = 0; top <= 1200; top += 7) {
      const a = grid(top)
      expect(grid(top)).toEqual(a)
      expect(a.start % 8).toBe(0)
      expect(a.start).toBeLessThanOrEqual(a.end)
    }
  })

  it('stays inside the list', () => {
    // scrolled past the end (a folder that just lost rows), a partial last row
    const past = listWindow({ total: 20, row: 100, cols: 8, scrollTop: 5000, viewport: 400 })
    expect(past.start).toBeLessThanOrEqual(20)
    expect(past.end).toBe(20)
    expect(past.after).toBe(0)
    expect(listWindow({ total: 0, row: 100, cols: 8, scrollTop: 0, viewport: 400 })).toEqual({
      start: 0,
      end: 0,
      before: 0,
      after: 0,
    })
    // a list: one column, a header that scrolls with it; nonsense numbers are survived
    const list = listWindow({
      total: 500,
      row: 36,
      cols: 1,
      scrollTop: 36 + 36 * 50,
      viewport: 360,
      head: 36,
    })
    expect(list.start).toBe(48)
    expect(listWindow({ total: 5, row: 0, cols: 0, scrollTop: -9, viewport: 0 }).end).toBe(5)
  })
})

describe('roots and crumbs', () => {
  const device = (label: string, path: string | null, mounted = true): Device => ({
    id: label,
    label,
    icon: 'smartphone',
    kind: 'phone',
    path,
    uri: null,
    mounted,
    canMount: !mounted,
    canUnmount: mounted,
    canEject: false,
    removable: true,
    size: null,
    away: false,
  })
  const phone = '/run/user/1000/be62e5e5/storage/emulated/0'

  it('makes a root of every mounted device, and of nothing else', () => {
    expect(
      deviceRoots([
        device('Pixel', phone),
        device('Away', null, false),
        device('Stick', '/run/media/you/STICK'),
        device('System', '/'),
      ]),
    ).toEqual([
      { label: 'Pixel', path: phone },
      { label: 'Stick', path: '/run/media/you/STICK' },
    ])
  })

  it('starts at Home, at a device, or at /', () => {
    expect(pathCrumbs('/home/you', '/home/you')).toEqual([{ label: 'Home', path: '/home/you' }])
    expect(pathCrumbs('/home/you/Music/a', '/home/you').map((c) => c.label)).toEqual([
      'Home',
      'Music',
      'a',
    ])
    expect(pathCrumbs('/etc/pacman.d', '/home/you')).toEqual([
      { label: '/', path: '/' },
      { label: 'etc', path: '/etc' },
      { label: 'pacman.d', path: '/etc/pacman.d' },
    ])
    expect(pathCrumbs('/', '/home/you')).toEqual([{ label: '/', path: '/' }])
    expect(pathCrumbs('', '/home/you')).toEqual([])
  })

  it('reads a phone as a place, not as where it is mounted', () => {
    const roots = deviceRoots([device('Pixel', phone)])
    expect(pathCrumbs(phone, '/home/you', roots)).toEqual([{ label: 'Pixel', path: phone }])
    expect(pathCrumbs(`${phone}/DCIM/Camera`, '/home/you', roots)).toEqual([
      { label: 'Pixel', path: phone },
      { label: 'DCIM', path: `${phone}/DCIM` },
      { label: 'Camera', path: `${phone}/DCIM/Camera` },
    ])
    // above the root it is an ordinary path again, and a sibling is not inside
    expect(pathCrumbs('/run/user/1000', '/home/you', roots)[0]).toEqual({ label: '/', path: '/' })
    expect(pathCrumbs(`${phone}0/x`, '/home/you', roots)[0]).toEqual({ label: '/', path: '/' })
  })

  it('takes the deepest root that holds the path', () => {
    const roots = [
      { label: 'Stick', path: '/home/you/mnt' },
      { label: 'Card', path: '/home/you/mnt/card' },
    ]
    expect(pathCrumbs('/home/you/mnt/card/a', '/home/you', roots).map((c) => c.label)).toEqual([
      'Card',
      'a',
    ])
    expect(pathCrumbs('/home/you/mnt', '/home/you', roots).map((c) => c.label)).toEqual(['Stick'])
  })
})
