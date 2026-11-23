// Typed access to the Rust side (apps/files/src-tauri/src/lib.rs) and its events.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { boot } from '@ewe/ui'
import type {
  AppEntry,
  AppInfo,
  AppListing,
  ArchiveListing,
  CardInfo,
  Device,
  DeviceResult,
  EepActivity,
  EepAdded,
  FileClipboard,
  FsPlace,
  Launch,
  MimeInfo,
  MountAsk,
  MountQuestion,
  OpKind,
  OpProgress,
  PathStat,
  Resolution,
  SearchFilters,
  SearchResults,
  SizeProgress,
  Tools,
  TrashEntry,
} from '@ewe/shared'

export const windowLabel = (): string => getCurrentWebviewWindow().label

export const api = {
  /** what this window was asked to open: on the window already (the core's boot
   *  script), else asked for */
  windowLaunch: (): Promise<Launch> => {
    const known = boot().launch
    return known === undefined || known === null
      ? invoke<Launch>('window_launch')
      : Promise.resolve(known)
  },
  newWindow: (paths: string[], flags: string[] = []) =>
    invoke<string>('new_window', { paths, flags }),
  windowClosed: () => invoke<null>('window_closed'),
  list: (path: string, hidden: boolean) => invoke<AppListing>('list_dir', { path, hidden }),
  places: () => invoke<FsPlace[]>('places'),
  devices: () => invoke<Device[]>('devices_list'),
  deviceAction: (id: string, action: 'mount' | 'unmount' | 'eject') =>
    invoke<null>('device_action', { id, action }),
  connectServer: (uri: string) => invoke<null>('connect_server', { uri }),
  mountReply: (reply: {
    id: number
    cancel?: boolean
    username?: string
    password?: string
    domain?: string
    anonymous?: boolean
    remember?: boolean
    choice?: number
  }) => invoke<boolean>('mount_reply', { reply }),
  watch: (pane: string, path: string | null) => invoke<null>('watch_dir', { pane, path }),
  mkdir: (dir: string, name: string) => invoke<string>('make_folder', { dir, name }),
  mkfile: (dir: string, name: string, template: string | null) =>
    invoke<string>('make_file', { dir, name, template }),
  rename: (path: string, name: string) => invoke<string>('rename_entry', { path, name }),
  link: (target: string, dir: string) => invoke<string>('make_link', { target, dir }),
  templates: () => invoke<AppEntry[]>('templates'),
  opStart: (kind: OpKind, sources: string[], dest: string | null) =>
    invoke<number>('op_start', { kind, sources, dest }),
  opPause: (id: number) => invoke<boolean>('op_pause', { id }),
  opResume: (id: number) => invoke<boolean>('op_resume', { id }),
  opCancel: (id: number) => invoke<boolean>('op_cancel', { id }),
  opResolve: (id: number, choice: Resolution, all: boolean) =>
    invoke<boolean>('op_resolve', { id, choice, all }),
  opDismiss: (id: number) => invoke<null>('op_dismiss', { id }),
  opsList: () => invoke<OpProgress[]>('ops_list'),
  undo: () => invoke<{ label: string; paths: string[] } | null>('undo'),
  undoLabel: () => invoke<string | null>('undo_label'),
  trashList: () => invoke<TrashEntry[]>('trash_list'),
  archiveList: (path: string) => invoke<ArchiveListing>('archive_list', { path }),
  archiveExtract: (path: string, dest: string | null) =>
    invoke<string>('archive_extract', { path, dest }),
  archiveCompress: (paths: string[], format: string, name: string | null) =>
    invoke<string>('archive_compress', { paths, format, name }),
  searchStart: (root: string, filters: SearchFilters) =>
    invoke<number>('search_start', { root, filters }),
  searchStop: () => invoke<null>('search_stop'),
  searchEverywhere: (query: string) => invoke<AppEntry[]>('search_everywhere', { query }),
  stat: (path: string) => invoke<PathStat>('stat_path', { path }),
  chmod: (path: string, mode: number) => invoke<null>('chmod_path', { path, mode }),
  folderSizeStart: (paths: string[]) => invoke<number>('folder_size_start', { paths }),
  folderSizeStop: (id: number) => invoke<null>('folder_size_stop', { id }),
  openTerminal: (dir: string) => invoke<string>('open_terminal', { dir }),
  setWallpaper: (path: string) => invoke<null>('set_wallpaper', { path }),
  runExecutable: (path: string, terminal: boolean) =>
    invoke<null>('run_executable', { path, terminal }),
  komble: (path: string) => invoke<null>('komble_install', { path }),
  eepOpen: (path: string, id: number) => invoke<null>('eep_open', { path, id }),
  /** what eep is installing right now (then follow `eep-activity`) */
  eepActivity: () => invoke<EepActivity[]>('eep_activity'),
  /** a card before its app is installed: the app, and what eep says it takes */
  eepCard: (path: string) => invoke<CardInfo>('eep_card', { path }),
  /** Install: the card moves into Applications and its app is fetched (`eep-add`) */
  eepAdd: (path: string, id: number) => invoke<null>('eep_add', { path, id }),
  /** Komble, where apps come from */
  openStore: () => invoke<null>('open_store'),
  eweSync: (
    op: 'available' | 'pane' | 'add-folder',
    extra: { pane?: string; path?: string } = {},
  ) => invoke<boolean>('ewe_sync', { op, pane: extra.pane ?? null, path: extra.path ?? null }),
  tools: () => invoke<Tools>('tools'),
  clipboardSet: (mode: 'copy' | 'cut', paths: string[]) =>
    invoke<boolean>('clipboard_set', { mode, paths }),
  clipboardGet: () => invoke<FileClipboard | null>('clipboard_get'),
  // the core's
  mimeOf: (path: string) => invoke<MimeInfo>('mime_of', { path }),
  appsFor: (contentType: string, all = false) =>
    invoke<AppInfo[]>('apps_for', { contentType, all }),
  setDefaultApp: (desktopId: string, contentType: string) =>
    invoke<null>('set_default_app', { desktopId, contentType }),
  launchWith: (desktopId: string | null, paths: string[]) =>
    invoke<null>('launch_with', { desktopId, paths }),
}

export interface Events {
  'op-progress': OpProgress
  'fs-changed': { key: string; path: string }
  'search-results': SearchResults
  'size-progress': SizeProgress
  /** `eep open` could not open an app: its error in words */
  'eep-open': { window: string; id: number; error: string }
  /** what eep is installing changed (every entry, each time) */
  'eep-activity': EepActivity[]
  /** an `eep add` this window started is done */
  'eep-add': EepAdded
  'devices-changed': null
  'device-result': DeviceResult
  'mount-ask': MountAsk
  'mount-question': MountQuestion
  launch: Launch
}

/** Listen to an app event; returns a stop function safe to call early. */
export function on<K extends keyof Events>(
  name: K,
  handler: (payload: Events[K]) => void,
): () => void {
  let off: UnlistenFn | null = null
  let stopped = false
  void listen<Events[K]>(name, (e) => {
    if (!stopped) handler(e.payload)
  }).then((stop) => {
    if (stopped) stop()
    else off = stop
  })
  return () => {
    stopped = true
    off?.()
  }
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return 'Something went wrong'
}
