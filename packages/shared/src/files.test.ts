import { describe, expect, it } from 'vitest'
import {
  displayName,
  fileKind,
  filterEntries,
  gvfsLabel,
  isFileName,
  isLocalPathInput,
  samePlaces,
  sortEntries,
  tildePath,
  type FsEntry,
  isEweSyncRequest,
  syncAction,
  syncLabel,
  syncRootOf,
  type FsPlace,
  type FsPlaceSync,
} from './files'

function entry(name: string, dir = false, size = 0, mtime = 0): FsEntry {
  return {
    name,
    path: `/x/${name}`,
    kind: dir ? 'dir' : 'file',
    dir,
    size,
    mtime,
    hidden: name.startsWith('.'),
    target: null,
  }
}

describe('paths', () => {
  it('treats absolute and home paths typed in a path field as folders', () => {
    expect(isLocalPathInput('/etc')).toBe(true)
    expect(isLocalPathInput('~')).toBe(true)
    expect(isLocalPathInput('~/Downloads')).toBe(true)
    expect(isLocalPathInput('//host/share')).toBe(false)
    expect(isLocalPathInput('example.com')).toBe(false)
  })

  it('shortens paths under home', () => {
    expect(tildePath('/home/me', '/home/me')).toBe('~')
    expect(tildePath('/home/me/a', '/home/me')).toBe('~/a')
    expect(tildePath('/home/meow', '/home/me')).toBe('/home/meow')
  })
})

describe('isFileName', () => {
  it('accepts plain names and rejects slashes, dots and NUL', () => {
    expect(isFileName('New folder')).toBe(true)
    expect(isFileName('a b.txt')).toBe(true)
    expect(isFileName('../evil')).toBe(false)
    expect(isFileName('..')).toBe(false)
    expect(isFileName('.')).toBe(false)
    expect(isFileName('')).toBe(false)
    expect(isFileName('a\0b')).toBe(false)
    expect(isFileName('x'.repeat(256))).toBe(false)
  })
})

describe('entries', () => {
  it('classifies files by extension', () => {
    expect(fileKind(entry('photo.JPG'))).toBe('image')
    expect(fileKind(entry('clip.mkv'))).toBe('video')
    expect(fileKind(entry('song.flac'))).toBe('audio')
    expect(fileKind(entry('notes.md'))).toBe('text')
    expect(fileKind(entry('main.rs'))).toBe('code')
    expect(fileKind(entry('src', true))).toBe('folder')
    expect(fileKind(entry('.bashrc'))).toBe('other')
    expect(fileKind(entry('README'))).toBe('other')
  })

  it('sorts folders first, naturally, by any key', () => {
    const list = [
      entry('file10.txt', false, 5, 3),
      entry('file2.txt', false, 50, 1),
      entry('Zeta', true),
      entry('alpha', true),
    ]
    expect(sortEntries(list, 'name', false).map((e) => e.name)).toEqual([
      'alpha',
      'Zeta',
      'file2.txt',
      'file10.txt',
    ])
    expect(sortEntries(list, 'size', true).map((e) => e.name)).toEqual([
      'Zeta',
      'alpha',
      'file2.txt',
      'file10.txt',
    ])
    expect(
      sortEntries(list, 'mtime', false)
        .map((e) => e.name)
        .slice(2),
    ).toEqual(['file2.txt', 'file10.txt'])
    expect(filterEntries(list, 'FILE1').map((e) => e.name)).toEqual(['file10.txt'])
  })

  it('shows an eep card as its app', () => {
    const app = (file: string, name: string) => ({
      ...entry(file),
      app: { name, id: name.toLowerCase(), version: '1', kind: 'gui', icon: true },
    })
    const firefox = app('Firefox.eep', 'Firefox')
    // renamed on disk: the card's name still counts
    const gimp = app('zz-renamed.eep', 'GIMP')
    const broken = entry('Broken.eep')
    expect(displayName(firefox)).toBe('Firefox')
    expect(displayName(broken)).toBe('Broken.eep')
    expect(fileKind(firefox)).toBe('app')
    expect(fileKind(broken)).toBe('other')
    const list = [gimp, broken, firefox, entry('apps', true)]
    expect(sortEntries(list, 'name', false).map(displayName)).toEqual([
      'apps',
      'Broken.eep',
      'Firefox',
      'GIMP',
    ])
    expect(filterEntries(list, 'gim').map(displayName)).toEqual(['GIMP'])
    expect(filterEntries(list, '.eep').map(displayName)).toEqual(['Broken.eep'])
  })

  it('labels GVFS mounts', () => {
    expect(gvfsLabel('smb-share:server=nas.local,share=media')).toEqual({
      label: 'media on nas.local',
      icon: 'server',
    })
    expect(gvfsLabel('google-drive:host=gmail.com,user=me')).toEqual({
      label: 'Google Drive (me)',
      icon: 'cloud',
    })
    expect(gvfsLabel('sftp:host=box,user=root').label).toBe('root@box')
    expect(gvfsLabel('davs:host=cloud.example.org,ssl=true').label).toBe('cloud.example.org')
    expect(gvfsLabel('mtp:host=Google_Pixel_8').label).toBe('Google Pixel 8')
    expect(gvfsLabel('plain').label).toBe('plain')
  })
})

describe('synced folders', () => {
  const place = (path: string, sync?: FsPlaceSync): FsPlace => ({
    id: path,
    label: path.split('/').pop() ?? path,
    path,
    group: sync === undefined ? 'places' : 'synced',
    icon: 'folder',
    state: 'ready',
    ...(sync === undefined ? {} : { sync }),
  })
  const sync = (state: FsPlaceSync['state'], conflicts = 0): FsPlaceSync => ({
    state,
    conflicts,
    lastSync: null,
    engine: 'ewe',
    error: '',
  })
  const places = [
    place('/h'),
    place('/h/Documents', sync('synced')),
    place('/h/Documents/Inner', sync('syncing')),
    place('/h/Work/Notes', sync('paused')),
  ]

  it('finds the deepest synced folder a path sits in', () => {
    expect(syncRootOf('/h/Documents/a/b', places)?.path).toBe('/h/Documents')
    expect(syncRootOf('/h/Documents/Inner/x', places)?.path).toBe('/h/Documents/Inner')
    expect(syncRootOf('/h/Documents2', places)).toBeNull()
    expect(syncRootOf('/h', places)).toBeNull()
  })

  it('offers keep, settings or nothing', () => {
    expect(syncAction('/h/Pictures', places, '/h')).toBe('keep')
    expect(syncAction('/h/Documents', places, '/h')).toBe('settings')
    expect(syncAction('/h/Documents/a', places, '/h')).toBe('settings')
    expect(syncAction('/h/Work', places, '/h')).toBeNull()
    expect(syncAction('/h', places, '/h')).toBeNull()
    expect(syncAction('/srv/data', places, '/h')).toBeNull()
    expect(syncAction('/h/x', places, '')).toBeNull()
  })

  it('says what state a folder is in', () => {
    expect(syncLabel(sync('synced'))).toBe('In your account')
    expect(syncLabel(sync('conflict', 1))).toBe('1 conflict')
    expect(syncLabel(sync('conflict', 4))).toBe('4 conflicts')
    expect(syncLabel(sync('conflict'))).toBe('Needs a decision')
    expect(syncLabel(sync('paused'))).toBe('Paused on this computer')
    expect(syncLabel(sync('error'))).toBe("Couldn't sync")
  })

  it('validates requests to start ewe-sync', () => {
    expect(isEweSyncRequest({ op: 'available' })).toBe(true)
    expect(isEweSyncRequest({ op: 'pane', pane: 'folders' })).toBe(true)
    expect(isEweSyncRequest({ op: 'pane', pane: 'secrets' })).toBe(false)
    expect(isEweSyncRequest({ op: 'add-folder', path: '/h/Work' })).toBe(true)
    expect(isEweSyncRequest({ op: 'add-folder', path: 'Work' })).toBe(false)
    expect(isEweSyncRequest({ op: 'add-folder', path: '/h/a\0b' })).toBe(false)
    expect(isEweSyncRequest({ op: 'run' })).toBe(false)
    expect(isEweSyncRequest(null)).toBe(false)
  })
})

describe('samePlaces', () => {
  const place = (state: 'synced' | 'syncing'): FsPlace => ({
    id: 'a',
    label: 'A',
    path: '/a',
    group: 'cloud',
    icon: 'folder',
    state: 'ready',
    sync: { state, conflicts: 0, lastSync: null, engine: 'ewe', error: '' },
  })

  it('tells a refresh that found nothing new from a real change', () => {
    expect(samePlaces([place('synced')], [place('synced')])).toBe(true)
    expect(samePlaces([place('synced')], [place('syncing')])).toBe(false)
    expect(samePlaces([place('synced')], [])).toBe(false)
  })
})
