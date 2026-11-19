// What ewe Files (apps/files) and its Rust side (apps/files/src-tauri) exchange,
// on top of the browser-era shapes in files.ts. serde camelCase on the wire.

import type { FsEntry } from './files'

/** A listing row from the Rust side: `FsEntry` plus the permission bits. */
export interface AppEntry extends FsEntry {
  mode: number
}

export interface AppListing {
  path: string
  parent: string | null
  entries: AppEntry[]
  writable: boolean
  free: number | null
}

export type OpKind = 'copy' | 'move' | 'trash' | 'delete' | 'restore' | 'empty-trash'
export type OpState = 'queued' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'cancelled'
export type Resolution = 'replace' | 'skip' | 'keep-both' | 'cancel'

export interface OpConflict {
  source: string
  dest: string
  sourceSize: number
  destSize: number
  sourceMtime: number
  destMtime: number
  dir: boolean
}

export interface OpProgress {
  id: number
  kind: OpKind
  window: string
  state: OpState
  label: string
  totalBytes: number
  doneBytes: number
  totalItems: number
  doneItems: number
  current: string
  speed: number
  eta: number | null
  error: string | null
  conflict: OpConflict | null
  results: string[]
  undoable: boolean
  started: number
}

export interface TrashEntry {
  name: string
  path: string
  original: string
  deleted: number
  size: number
  dir: boolean
  mtime: number
  mode: number
}

export interface Device {
  id: string
  label: string
  icon: 'usb' | 'hard-drive' | 'disc' | 'smartphone' | 'server' | 'cloud'
  kind: 'drive' | 'phone' | 'optical' | 'network'
  path: string | null
  uri: string | null
  mounted: boolean
  canMount: boolean
  canUnmount: boolean
  canEject: boolean
  removable: boolean
  size: number | null
}

export interface DeviceResult {
  id: string
  action: 'mount' | 'unmount' | 'eject' | 'connect'
  ok: boolean
  path?: string | null
  error?: string
  cancelled?: boolean
}

export interface MountAsk {
  id: number
  message: string
  defaultUser: string
  defaultDomain: string
  needsPassword: boolean
  needsUsername: boolean
  needsDomain: boolean
  anonymousOk: boolean
  canRemember: boolean
}

export interface MountQuestion {
  id: number
  message: string
  choices: string[]
}

export interface PathStat {
  path: string
  name: string
  dir: boolean
  link: string | null
  size: number
  mode: number
  uid: number
  gid: number
  owner: string
  group: string
  accessed: number
  modified: number
  changed: number
  links: number
  inode: number
  device: number
  mount: string
  free: number | null
  total: number | null
  mine: boolean
}

export interface SizeProgress {
  id: number
  bytes: number
  files: number
  dirs: number
  done: boolean
}

export interface SearchFilters {
  query: string
  kind: '' | 'folder' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'code'
  days: number
  minSize: number
  maxSize: number
  hidden: boolean
}

export interface SearchResults {
  id: number
  window: string
  items: AppEntry[]
  done: boolean
}

export interface Tools {
  plocate: boolean
  bsdtar: boolean
  sevenZip: boolean
  unar: boolean
  komble: boolean
  eweSync: boolean
  eweConf: boolean
  terminal: boolean
  home: string
  user: string
}

export interface FileClipboard {
  mode: 'copy' | 'cut'
  paths: string[]
}

export type CompressFormat = 'zip' | 'tar.gz' | 'tar.zst' | '7z'
export const COMPRESS_FORMATS: readonly CompressFormat[] = ['zip', 'tar.gz', 'tar.zst', '7z']

/** The special folder of the Trash place. */
export const TRASH_PATH = 'trash://'

export function baseName(path: string): string {
  if (path === '/') return '/'
  return path.slice(path.lastIndexOf('/') + 1)
}

export function parentOf(path: string): string | null {
  if (path === '/' || path === '') return null
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** `name`, else `name 2`, `name 3`… among `taken`. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const names = new Set(taken)
  if (!names.has(base)) return base
  for (let n = 2; n < 1000; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`
  return `${base} ${Date.now()}`
}

export function isExecutable(entry: Pick<AppEntry, 'mode' | 'dir'>): boolean {
  return !entry.dir && (entry.mode & 0o111) !== 0
}

export function isAppImage(name: string): boolean {
  return name.toLowerCase().endsWith('.appimage')
}

/** `rwxr-xr--` */
export function modeText(mode: number): string {
  const bits = ['x', 'w', 'r']
  let out = ''
  for (let shift = 8; shift >= 0; shift--)
    out += mode & (1 << shift) ? (bits[shift % 3] ?? '-') : '-'
  return out
}

/** The three rwx triplets as numbers 0–7. */
export function modeTriplets(mode: number): [number, number, number] {
  return [(mode >> 6) & 7, (mode >> 3) & 7, mode & 7]
}

export function modeFromTriplets(t: readonly [number, number, number], special = 0): number {
  return (special & 0o7000) | (t[0] << 6) | (t[1] << 3) | t[2]
}

export type RenameCase = 'keep' | 'lower' | 'upper' | 'title'

export interface BatchRename {
  find: string
  replace: string
  /** `{n}` numbering: start and digits; 0 digits = off */
  numberStart: number
  numberDigits: number
  prefix: string
  suffix: string
  case: RenameCase
}

export const DEFAULT_BATCH_RENAME: BatchRename = {
  find: '',
  replace: '',
  numberStart: 1,
  numberDigits: 0,
  prefix: '',
  suffix: '',
  case: 'keep',
}

function splitName(name: string, dir: boolean): [string, string] {
  if (dir) return [name, '']
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** New names for `entries` (in order); the extension is left alone. */
export function batchRenameNames(
  entries: readonly Pick<AppEntry, 'name' | 'dir'>[],
  rule: BatchRename,
): string[] {
  return entries.map((e, i) => {
    const [stem0, ext] = splitName(e.name, e.dir)
    let stem = stem0
    if (rule.find !== '') stem = stem.split(rule.find).join(rule.replace)
    if (rule.case === 'lower') stem = stem.toLowerCase()
    else if (rule.case === 'upper') stem = stem.toUpperCase()
    else if (rule.case === 'title')
      stem = stem.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (m) => m.toUpperCase())
    if (rule.numberDigits > 0) {
      const n = String(rule.numberStart + i).padStart(rule.numberDigits, '0')
      stem = stem.includes('{n}') ? stem.split('{n}').join(n) : `${stem} ${n}`
    }
    return `${rule.prefix}${stem}${rule.suffix}${ext}`
  })
}
