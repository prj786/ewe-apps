export type FsEntryKind = 'dir' | 'file' | 'link' | 'other'

/**
 * An eep card (`<Name>.eep`, eep/docs/CARD.md) is an app: the row shows the app's
 * `name`, never the file name, and the icon embedded in the card.
 */
export interface AppCard {
  name: string
  id: string
  /** empty when the card has none */
  version: string
  /** eep's `gui` | `cli` | `tool`, empty when the card has none */
  kind: string
  /** the card embeds an icon (the core's `/app-icon`) */
  icon: boolean
}

export interface FsEntry {
  name: string
  path: string
  kind: FsEntryKind
  dir: boolean
  size: number
  mtime: number
  hidden: boolean
  target: string | null
  /** a readable eep card: the app it is */
  app?: AppCard | undefined
}

/** What a row is called: an eep card's app name, else the file name. */
export function displayName(entry: Pick<FsEntry, 'name' | 'app'>): string {
  return entry.app?.name ?? entry.name
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
  writable: boolean
  free: number | null
}

export type FsPlaceGroup = 'places' | 'cloud' | 'synced' | 'bookmarks' | 'devices' | 'other'
export type FsPlaceState = 'ready' | 'offline' | 'setup'
export type FsPlaceIcon =
  | 'house'
  | 'folder'
  | 'download'
  | 'file'
  | 'image'
  | 'music'
  | 'video'
  | 'code'
  | 'cloud'
  | 'drive'
  | 'hard-drive'
  | 'server'
  | 'trash-2'
  | 'monitor'
  | 'app-window'

export interface FsPlace {
  id: string
  label: string
  path: string
  group: FsPlaceGroup
  icon: FsPlaceIcon
  state: FsPlaceState
  mount?: 'nextcloud' | 'drive' | undefined
  sync?: FsPlaceSync | undefined
}

export type FsSyncState =
  'synced' | 'syncing' | 'pending' | 'paused' | 'error' | 'conflict' | 'offline'

export interface FsPlaceSync {
  state: FsSyncState
  conflicts: number
  lastSync: number | null
  engine: 'ewe' | 'nextcloud-app'
  error: string
}

// Plain data from one source, so the same order means the same text. A refresh that found nothing
// new must not hand a keyed list new objects: it rebuilds every row.
export function samePlaces(a: readonly FsPlace[], b: readonly FsPlace[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function isInsidePath(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/')
  return child === parent || child.startsWith(`${parent}/`)
}

export function syncRootOf(path: string, places: readonly FsPlace[]): FsPlace | null {
  let best: FsPlace | null = null
  for (const place of places) {
    if (place.sync === undefined || !isInsidePath(path, place.path)) continue
    if (best === null || place.path.length > best.path.length) best = place
  }
  return best
}

export function syncAction(
  path: string,
  places: readonly FsPlace[],
  home: string,
): 'keep' | 'settings' | null {
  if (syncRootOf(path, places) !== null) return 'settings'
  if (home === '' || home === '/' || path === home || !isInsidePath(path, home)) return null
  if (places.some((p) => p.sync !== undefined && isInsidePath(p.path, path))) return null
  return 'keep'
}

export function syncLabel(sync: FsPlaceSync): string {
  switch (sync.state) {
    case 'synced':
      return 'In your account'
    case 'syncing':
      return 'Syncing…'
    case 'pending':
      return 'Waiting to sync'
    case 'paused':
      return 'Paused on this computer'
    case 'error':
      return "Couldn't sync"
    case 'conflict':
      return sync.conflicts > 0
        ? `${sync.conflicts} conflict${sync.conflicts === 1 ? '' : 's'}`
        : 'Needs a decision'
    case 'offline':
      return 'Offline'
  }
}

export type EweSyncPane =
  'overview' | 'folders' | 'machine' | 'machines' | 'account' | 'mail' | 'google'

const EWE_SYNC_PANES: ReadonlySet<string> = new Set([
  'overview',
  'folders',
  'machine',
  'machines',
  'account',
  'mail',
  'google',
])

export type EweSyncRequest =
  { op: 'available' } | { op: 'pane'; pane: EweSyncPane } | { op: 'add-folder'; path: string }

export function isEweSyncRequest(value: unknown): value is EweSyncRequest {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  switch (r.op) {
    case 'available':
      return true
    case 'pane':
      return typeof r.pane === 'string' && EWE_SYNC_PANES.has(r.pane)
    case 'add-folder':
      return (
        typeof r.path === 'string' &&
        r.path.startsWith('/') &&
        r.path.length <= 4096 &&
        !r.path.includes('\0')
      )
    default:
      return false
  }
}

export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar.zst' | '7z'

export interface ArchiveEntry {
  name: string
  dir: boolean
  size: number
}

export interface ArchiveListing {
  path: string
  count: number
  size: number
  entries: ArchiveEntry[]
  truncated: boolean
  root: string | null
}

export type FsClipboard = { mode: 'copy' | 'cut'; paths: string[] } | null

export type FsResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

export function isFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes('/') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..'
  )
}

export function isLocalPathInput(input: string): boolean {
  return input === '~' || input.startsWith('~/') || /^\/(?!\/)/.test(input)
}

export function tildePath(path: string, home: string): string {
  if (home === '' || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export type FileKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'code'
  | 'archive'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'font'
  | 'disk'
  | 'executable'
  | 'package'
  | 'app'
  | 'other'

const KINDS: Record<string, FileKind> = {}
function register(kind: FileKind, exts: string): void {
  for (const ext of exts.split(' ')) KINDS[ext] = kind
}
register(
  'image',
  'png jpg jpeg gif webp avif bmp svg ico tif tiff heic heif jxl raw cr2 nef psd xcf',
)
register('video', 'mp4 m4v mkv webm mov avi wmv flv mpg mpeg 3gp m2ts ogv')
register('audio', 'mp3 flac ogg oga opus wav m4a aac wma aiff alac mka')
register('pdf', 'pdf')
register('text', 'txt md markdown rst log csv tsv ini conf cfg toml yaml yml nfo srt vtt')
register(
  'code',
  'js mjs cjs ts tsx jsx json html htm css scss less py rb go rs c h cpp hpp cc java kt swift sh bash zsh fish lua qml php sql xml vue svelte nix dart zig',
)
register('archive', 'zip tar gz tgz bz2 xz zst 7z rar lz4 deb rpm pkg apk jar whl')
register('document', 'doc docx odt rtf epub pages')
register('sheet', 'xls xlsx ods numbers')
register('slides', 'ppt pptx odp key')
register('font', 'ttf otf woff woff2')
register('disk', 'iso img qcow2 vdi vmdk dmg')
register('executable', 'exe msi run')
register('package', 'appimage flatpak flatpakref snap')

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function fileKind(entry: Pick<FsEntry, 'name' | 'dir' | 'app'>): FileKind {
  if (entry.dir) return 'folder'
  if (entry.app !== undefined) return 'app'
  return KINDS[extensionOf(entry.name)] ?? 'other'
}

export const MEDIA_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['image', 'video', 'audio'])

export const VIEWABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'image',
  'video',
  'audio',
  'text',
  'code',
  'pdf',
])

export const THUMBNAIL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['image', 'video'])

export type SortKey = 'name' | 'mtime' | 'size' | 'kind'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortEntries(entries: FsEntry[], key: SortKey, descending: boolean): FsEntry[] {
  const sign = descending ? -1 : 1
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    let order = 0
    if (key === 'mtime') order = a.mtime - b.mtime
    else if (key === 'size') order = a.dir ? 0 : a.size - b.size
    else if (key === 'kind') order = collator.compare(fileKind(a), fileKind(b))
    if (order === 0) order = collator.compare(displayName(a), displayName(b))
    return order * sign
  })
}

export function filterEntries(entries: FsEntry[], query: string): FsEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return entries
  return entries.filter((e) => displayName(e).toLowerCase().includes(q))
}

function gvfsParams(spec: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const raw = part.slice(eq + 1)
    try {
      out[part.slice(0, eq)] = decodeURIComponent(raw)
    } catch {
      out[part.slice(0, eq)] = raw
    }
  }
  return out
}

export function gvfsLabel(name: string): { label: string; icon: FsPlaceIcon } {
  const colon = name.indexOf(':')
  if (colon <= 0) return { label: name, icon: 'server' }
  const type = name.slice(0, colon)
  const p = gvfsParams(name.slice(colon + 1))
  const host = p.host ?? p.server ?? ''
  switch (type) {
    case 'google-drive':
      return { label: `Google Drive (${p.user ?? host})`, icon: 'cloud' }
    case 'smb-share':
      return { label: `${p.share ?? 'share'} on ${host}`, icon: 'server' }
    case 'sftp':
    case 'ftp':
      return { label: `${p.user === undefined ? '' : `${p.user}@`}${host}`, icon: 'server' }
    case 'dav':
    case 'davs':
      return { label: host === '' ? 'WebDAV' : host, icon: 'cloud' }
    case 'mtp':
    case 'gphoto2':
      return { label: host.replace(/_/g, ' ') || 'Device', icon: 'drive' }
    default:
      return { label: host === '' ? name : `${host} (${type})`, icon: 'server' }
  }
}
