// What ewe Files (apps/files) and its Rust side (apps/files/src-tauri) exchange,
// on top of the browser-era shapes in files.ts. serde camelCase on the wire.

import type { AppCard, FsEntry } from './files'

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
  /** a trashed eep card: the app (restoring it brings the app back) */
  app?: AppCard | undefined
}

// ---- apps (eep cards, eep/docs/CARD.md) ------------------------------------------

/** What eep says about an app it is installing or updating right now (one entry of
 *  its activity file, as the core reads it). */
export interface EepActivity {
  id: string
  name: string
  /** the app's card in Applications (an install from a store has none until done) */
  card: string | null
  what: 'install' | 'update'
  state: 'waiting' | 'downloading' | 'finishing' | 'failed'
  /** bytes unpacked so far and in all (0 = not known yet) */
  done: number
  total: number
  /** bytes the whole fetch downloads (0 = not known yet) */
  download: number
  error: string | null
}

/** A card before its app is installed (the Rust side's `CardInfo`). */
export interface CardInfo {
  path: string
  mtime: number
  app: AppCard
  /** eep's `eep card <file>`; null without eep, or when eep does not take the card */
  info: {
    /** the file itself is in Applications */
    inside: boolean
    /** the card that holds this app in Applications */
    installed: string | null
    ready: boolean
    /** bytes an install would download now (known when eep's index has the app) */
    download?: number
    /** a found app: it is on this computer */
    present?: boolean
  } | null
}

/** `eep add` is done (the `eep-add` event). */
export interface EepAdded {
  window: string
  id: number
  ok: boolean
  error: string | null
  /** the app's card in Applications */
  card: string | null
  appId: string | null
}

/**
 * How an app's card in Applications stands:
 * `ready` — click and it starts; `updating` — it starts, a newer version is on its way;
 * `waiting` — the card arrived and eep has not begun (or is busy with another app);
 * `installing` / `finishing` — eep is at it; `failed` — eep could not, it tries again.
 */
export type AppStanding = 'ready' | 'updating' | 'waiting' | 'installing' | 'finishing' | 'failed'

export function appStanding(
  app: Pick<AppCard, 'ready'>,
  activity: EepActivity | undefined,
): AppStanding {
  if (app.ready) return activity !== undefined && activity.state !== 'failed' ? 'updating' : 'ready'
  switch (activity?.state) {
    case 'failed':
      return 'failed'
    case 'finishing':
      return 'finishing'
    case 'downloading':
      return 'installing'
    default:
      return 'waiting'
  }
}

/** How far a fetch is, 0–1; null while eep does not know the size yet. */
export function activityFraction(activity: EepActivity | undefined): number | null {
  if (activity === undefined || activity.total <= 0 || activity.state === 'waiting') return null
  if (activity.state === 'finishing') return 1
  return Math.min(1, Math.max(0, activity.done / activity.total))
}

/** The few words under an app that is not simply ready ("Installing 43%"). */
export function standingLabel(standing: AppStanding, activity: EepActivity | undefined): string {
  switch (standing) {
    case 'ready':
      return ''
    case 'updating':
      return 'Updating…'
    case 'waiting':
      return 'Waiting…'
    case 'finishing':
      return 'Finishing…'
    case 'failed':
      return 'Not installed'
    case 'installing': {
      const f = activityFraction(activity)
      return f === null ? 'Installing…' : `Installing ${Math.floor(f * 100)}%`
    }
  }
}

/** Bytes downloaded so far and in all, from how far the fetch is; null while unknown. */
export function activityBytes(
  activity: EepActivity | undefined,
): { done: number; total: number } | null {
  const f = activityFraction(activity)
  if (activity === undefined || f === null || activity.download <= 0) return null
  return { done: Math.round(activity.download * f), total: activity.download }
}

/** Where a found app came from, in words ("Arch package"); '' for an eep app. */
export function appOrigin(app: Pick<AppCard, 'system' | 'from'>): string {
  if (!app.system) return ''
  switch (app.from) {
    case 'pacman':
      return 'Arch package'
    case 'appimage':
      return 'AppImage'
    case 'steam':
      return 'Steam'
    case 'flatpak':
      return 'Flatpak'
    case 'local':
      return 'Your own launcher entry'
    default:
      return 'On this computer'
  }
}

// ---- windowed lists ---------------------------------------------------------------

/** What a windowed grid or list renders: rows `[start, end)` of the items, with this
 *  much empty space (px) before and after them. */
export interface ListWindow {
  start: number
  end: number
  before: number
  after: number
}

/**
 * Which items are in the DOM for a scroll position. Every row is `row` px tall (the
 * grid's rows are one height by design: a tile's name always keeps two lines), so the
 * answer depends only on the numbers given — never on which rows happen to be
 * rendered. `overscan` rows are kept above and below the viewport.
 */
export function listWindow(g: {
  total: number
  row: number
  cols: number
  scrollTop: number
  viewport: number
  /** px above the first row that scroll with it (the list's header) */
  head?: number
  overscan?: number
}): ListWindow {
  const row = Math.max(1, g.row)
  const cols = Math.max(1, Math.floor(g.cols))
  const overscan = g.overscan ?? 2
  const totalRows = Math.ceil(g.total / cols)
  const firstRow = Math.min(
    Math.max(0, totalRows - 1),
    Math.max(0, Math.floor((g.scrollTop - (g.head ?? 0)) / row) - overscan),
  )
  const visibleRows = Math.ceil(Math.max(1, g.viewport) / row) + overscan * 2 + 1
  return {
    start: Math.min(g.total, firstRow * cols),
    end: Math.min(g.total, (firstRow + visibleRows) * cols),
    before: firstRow * row,
    after: Math.max(0, (totalRows - firstRow - visibleRows) * row),
  }
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
  /** eep (the app manager) is installed: `.eep` cards open with `eep open` */
  eep: boolean
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

/** The file name a renamed eep card gets: the `.eep` stays whatever was typed. */
export function cardFileName(typed: string): string {
  const name = typed.trim()
  return /\.eep$/i.test(name) ? name : `${name}.eep`
}

/** The name an eep card's rename field starts with: the file name without `.eep`. */
export function cardStem(fileName: string): string {
  return fileName.replace(/\.eep$/i, '')
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
