// The window: tabs, split view, the places panel, menus, dialogs, the operations
// panel, quick look, keyboard, drag and drop, and what a launch asked for.

import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  TRASH_PATH,
  VIEWABLE_KINDS,
  baseName,
  fileKind,
  isAppImage,
  isExecutable,
  isFileName,
  parentOf,
  pictureUrl,
  rawUrl,
  readText,
  samePlaces,
  syncAction,
  thumbUrl,
  uniqueName,
  type AppEntry,
  type CompressFormat,
  type Device,
  type FsPlace,
  type Launch,
  type MediaServer,
  type MountAsk,
  type MountQuestion,
  type OpKind,
  type OpProgress,
  type Point,
  type SearchFilters,
  type ThumbSize,
  type Tools,
  type TrashEntry,
  type TextFile,
} from '@ewe/shared'
import {
  Icon,
  IconButton,
  Menu,
  Tabs,
  Toasts,
  applyShotSize,
  getMediaServer,
  toast,
  type IconName,
  type MenuEntry,
  type TabItem,
} from '@ewe/ui'
import { api, errorText, on as onEvent, windowLabel } from './api'
import {
  ArchiveDialog,
  CompressDialog,
  ConfirmDialog,
  ConflictDialog,
  ConnectDialog,
  CredentialsDialog,
  OpenWithDialog,
  PathDialog,
  PropertiesDialog,
  QuestionDialog,
  RenameManyDialog,
  RunDialog,
} from './dialogs'
import { OpsPanel } from './ops-panel'
import {
  Pane,
  SORT_KEYS,
  SORT_LABELS,
  emptyRow,
  type PaneCtx,
  type PaneHandle,
  type Row,
} from './pane'
import { pdfThumb } from './pdfview'
import { Places } from './places'
import { Preview } from './preview'
import { ZOOMS, loadPrefs, savePrefs, viewFor, type AppPrefs, type ViewPrefs } from './prefs'
import { SearchBar } from './search'
import { Viewer } from './viewer'

interface Tab {
  id: string
  panes: string[]
  active: number
  title: string
}

type Dialog =
  | { kind: 'properties'; paths: string[] }
  | { kind: 'open-with'; paths: string[] }
  | { kind: 'connect' }
  | { kind: 'credentials'; ask: MountAsk }
  | { kind: 'question'; q: MountQuestion }
  | { kind: 'rename-many'; entries: AppEntry[]; pane: PaneHandle }
  | { kind: 'compress'; paths: string[]; pane: PaneHandle }
  | { kind: 'run'; entry: AppEntry; pane: PaneHandle }
  | { kind: 'archive'; entry: Row; pane: PaneHandle | null }
  | { kind: 'extract-to'; entry: Row; pane: PaneHandle | null }
  | {
      kind: 'confirm'
      title: string
      description: string
      action: string
      danger: boolean
      run(): void
    }

function item(
  id: string,
  label: string,
  icon: IconName | null,
  run: () => void,
  extra: Partial<{ hint: string; disabled: boolean; danger: boolean }> = {},
): MenuEntry {
  return { type: 'item', id, label, ...(icon === null ? {} : { icon }), run, ...extra }
}
const sep = (): MenuEntry => ({ type: 'separator' })

let nextId = 1
const uid = (prefix: string) => `${prefix}${nextId++}`

export function App(): JSX.Element {
  const [prefs, setPrefs] = createSignal<AppPrefs>(loadPrefs())
  createEffect(() => savePrefs(prefs()))
  const [server, setServer] = createSignal<MediaServer | null>(null)
  const [tools, setTools] = createSignal<Tools | null>(null)
  const [places, setPlaces] = createSignal<FsPlace[]>([], { equals: samePlaces })
  const [devices, setDevices] = createSignal<Device[]>([])
  const [trashRows, setTrashRows] = createSignal<TrashEntry[]>([])
  // a store: a title or split change must not hand <For> new tab objects (it would
  // rebuild the panes, which reload, which set the title again — a loop)
  const [tabs, setTabs] = createStore<Tab[]>([])
  const [activeTab, setActiveTab] = createSignal('')
  const [paneInit, setPaneInit] = createSignal<
    Record<string, { path: string; select?: string[] | undefined }>
  >({})
  const panes = new Map<string, PaneHandle>()
  const [selection, setSelection] = createSignal<Record<string, Row[]>>({})
  const [menu, setMenu] = createSignal<{ at: Point; items: MenuEntry[] } | null>(null)
  const [dialog, setDialog] = createSignal<Dialog | null>(null)
  const [ops, setOps] = createSignal<OpProgress[]>([])
  const [opsOpen, setOpsOpen] = createSignal(false)
  const [viewer, setViewer] = createSignal<{ items: Row[]; index: number } | null>(null)
  const [dropTarget, setDropTarget] = createSignal<string | null>(null)
  const [cutPaths, setCutPaths] = createSignal<ReadonlySet<string>>(new Set())
  const [archive, setArchive] = createSignal<{
    path: string
    listing: Awaited<ReturnType<typeof api.archiveList>> | null
    error: string | null
    busy: boolean
  } | null>(null)
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [eweSync, setEweSync] = createSignal(false)
  let dragPaths: string[] | null = null
  let lastDomDrop = 0

  const home = () => tools()?.home ?? places().find((p) => p.id === 'home')?.path ?? '~'
  const label = windowLabel()

  // ---- window size ------------------------------------------------------------------
  // The window's width picks the layout (files.css has the same numbers as `app`
  // container queries): wide ≥ 1100 is the full layout; medium narrows the places column
  // and the preview; compact (< 760) puts places in a drawer and the preview over the
  // folder, and folds the header into ⋯; tiny (< 480) also scrolls the tab strip.
  const [winWidth, setWinWidth] = createSignal(window.innerWidth)
  const winSize = createMemo(() => {
    const w = winWidth()
    return w < 480 ? 'tiny' : w < 760 ? 'compact' : w < 1100 ? 'medium' : 'wide'
  })
  const compact = () => winWidth() < 760
  // compact windows open places and the preview for this session only: the saved prefs
  // stay as they are for when the window grows again
  const [placesDrawer, setPlacesDrawer] = createSignal(false)
  const [previewOverlay, setPreviewOverlay] = createSignal(false)
  createEffect(
    on(compact, (c) => {
      if (!c) {
        setPlacesDrawer(false)
        setPreviewOverlay(false)
      }
    }),
  )
  const placesShown = () => (compact() ? placesDrawer() : prefs().places)
  const previewShown = () => (compact() ? previewOverlay() : prefs().preview)
  const togglePlaces = () => {
    if (compact()) setPlacesDrawer((v) => !v)
    else setPrefs((p) => ({ ...p, places: !p.places }))
  }
  const togglePreview = () => {
    if (compact()) setPreviewOverlay((v) => !v)
    else setPrefs((p) => ({ ...p, preview: !p.preview }))
  }
  const showPreview = () => {
    if (compact()) setPreviewOverlay(true)
    else setPrefs((p) => ({ ...p, preview: true }))
  }
  // two panes need twice the pane's min-width (`.fm-pane` in files.css)
  const PANE_MIN = 300
  let mainEl: HTMLDivElement | undefined

  // ---- tabs and panes ------------------------------------------------------------

  const currentTab = createMemo(() => tabs.find((t) => t.id === activeTab()) ?? null)
  const activePaneId = () => {
    const t = currentTab()
    return t === null ? null : (t.panes[t.active] ?? null)
  }
  const activePane = (): PaneHandle | null => {
    const id = activePaneId()
    return id === null ? null : (panes.get(id) ?? null)
  }
  const activePath = () => activePane()?.path() ?? ''
  const otherPane = (): PaneHandle | null => {
    const t = currentTab()
    if (t === null || t.panes.length < 2) return null
    const id = t.panes[1 - t.active]
    return id === undefined ? null : (panes.get(id) ?? null)
  }

  const newPane = (path: string, select?: string[]): string => {
    const id = uid('pane')
    setPaneInit((m) => ({ ...m, [id]: { path, select } }))
    return id
  }

  const openTab = (path: string, options: { activate?: boolean; select?: string[] } = {}) => {
    const pane = newPane(path, options.select)
    const tab: Tab = { id: uid('tab'), panes: [pane], active: 0, title: baseName(path) || path }
    setTabs(tabs.length, tab)
    if (options.activate !== false || tabs.length === 1) setActiveTab(tab.id)
  }

  const closeTab = (id: string) => {
    const i = tabs.findIndex((t) => t.id === id)
    if (i === -1) return
    if (tabs.length === 1) {
      void getCurrentWindow().close()
      return
    }
    const next = tabs[i + 1]?.id ?? tabs[i - 1]?.id
    for (const p of tabs[i]?.panes ?? []) panes.delete(p)
    setTabs(produce((list) => list.splice(i, 1)))
    if (activeTab() === id && next !== undefined) setActiveTab(next)
  }

  const splitToggle = () => {
    const t = currentTab()
    if (t === null) return
    if (t.panes.length > 1) {
      const keep = t.panes[t.active] ?? t.panes[0] ?? ''
      for (const p of t.panes) if (p !== keep) panes.delete(p)
      setTabs((x) => x.id === t.id, 'panes', [keep])
      setTabs((x) => x.id === t.id, 'active', 0)
    } else {
      if ((mainEl?.clientWidth ?? 0) < 2 * PANE_MIN) {
        toast('Not enough room for two panes')
        return
      }
      const pane = newPane(activePath() === TRASH_PATH ? home() : activePath())
      setTabs(
        (x) => x.id === t.id,
        'panes',
        (p) => [...p, pane],
      )
      setTabs((x) => x.id === t.id, 'active', 1)
    }
  }

  const activatePane = (tabId: string, paneId: string) => {
    const t = tabs.find((x) => x.id === tabId)
    if (!t?.panes.includes(paneId)) return
    setTabs((x) => x.id === tabId, 'active', t.panes.indexOf(paneId))
  }

  createEffect(() => {
    const t = currentTab()
    void getCurrentWindow().setTitle(t === null ? 'ewe Files' : `${t.title} — ewe Files`)
  })

  // ---- data -----------------------------------------------------------------------

  const refreshPlaces = () => void api.places().then(setPlaces)
  const refreshDevices = () => void api.devices().then(setDevices)
  const refreshTrash = () => void api.trashList().then(setTrashRows)
  const refreshOps = () =>
    void api.opsList().then((list) => setOps(list.filter((o) => o.window === label)))

  const prefsFor = (path: string): ViewPrefs => viewFor(prefs(), path)
  const setPref = (path: string, patch: Partial<ViewPrefs>) => {
    setPrefs((p) => {
      const { hidden, ...rest } = patch
      const next: AppPrefs = { ...p, folders: { ...p.folders } }
      if (hidden !== undefined) next.hidden = hidden
      if (Object.keys(rest).length > 0) {
        // the app default moves along, and the folder remembers its own choice
        Object.assign(next, rest)
        if (path !== '' && path !== TRASH_PATH)
          next.folders[path] = { ...(p.folders[path] ?? {}), ...rest }
      }
      return next
    })
  }

  const thumb = (path: string, size: ThumbSize = 256): string => {
    const s = server()
    return s === null ? '' : thumbUrl(s, path, size)
  }
  const raw = (path: string): string => {
    const s = server()
    return s === null ? '' : rawUrl(s, path)
  }
  /** what an <img> shows: the raw file, or a JPEG of a HEIC the core converts */
  const picture = (path: string): string => {
    const s = server()
    return s === null ? '' : pictureUrl(s, path)
  }
  /** a text file as UTF-8 whatever it was written in (the core detects the encoding) */
  const readTextFile = (path: string, max?: number): Promise<TextFile> => {
    const s = server()
    return s === null
      ? Promise.reject(new Error('The media server is not ready'))
      : readText(s, path, { max })
  }

  const say = (text: string, kind: 'info' | 'danger' | 'success' = 'info') => toast(text, { kind })

  const reloadAll = () => {
    for (const p of panes.values()) p.reload()
    refreshTrash()
  }

  // ---- operations -------------------------------------------------------------------

  const startOp = (kind: OpKind, sources: string[], dest: string | null) => {
    if (sources.length === 0 && kind !== 'empty-trash') return
    void api.opStart(kind, sources, dest).then(() => {
      refreshOps()
      if (kind === 'copy' || kind === 'move') setOpsOpen(true)
    })
  }

  const trashSelected = (pane: PaneHandle, paths: string[]) => {
    if (paths.length === 0) return
    if (pane.mode() === 'trash') {
      confirmDelete(paths)
      return
    }
    void api.opStart('trash', paths, null).then((id) => {
      refreshOps()
      const watch = onEvent('op-progress', (p) => {
        if (p.id !== id) return
        if (p.state === 'done') {
          watch()
          say(
            paths.length === 1
              ? `Moved “${baseName(paths[0] ?? '')}” to Trash`
              : `Moved ${paths.length} items to Trash`,
          )
          toast('Moved to Trash', {
            kind: 'success',
            action: { label: 'Undo', run: () => void undo() },
          })
        } else if (p.state === 'failed') {
          watch()
          say(p.error ?? 'Could not move to Trash', 'danger')
        }
      })
    })
  }

  const confirmDelete = (paths: string[]) => {
    setDialog({
      kind: 'confirm',
      title:
        paths.length === 1
          ? `Delete “${baseName(paths[0] ?? '')}” forever?`
          : `Delete ${paths.length} items forever?`,
      description: 'This cannot be undone.',
      action: 'Delete forever',
      danger: true,
      run: () => {
        setDialog(null)
        startOp('delete', paths, null)
      },
    })
  }

  const undo = async () => {
    try {
      const r = await api.undo()
      if (r === null) say('Nothing to undo')
      else {
        say(`Undid: ${r.label}`, 'success')
        reloadAll()
      }
    } catch (e) {
      say(errorText(e), 'danger')
    }
  }

  const pasteInto = (dir: string) => {
    void api.clipboardGet().then((clip) => {
      if (clip === null || clip.paths.length === 0) {
        say('Nothing to paste')
        return
      }
      startOp(clip.mode === 'cut' ? 'move' : 'copy', clip.paths, dir)
      if (clip.mode === 'cut') {
        setCutPaths(new Set<string>())
        void api.clipboardSet('copy', clip.paths)
      }
    })
  }

  const setClip = (mode: 'copy' | 'cut', paths: string[]) => {
    if (paths.length === 0) return
    void api.clipboardSet(mode, paths).then(() => {
      setCutPaths(mode === 'cut' ? new Set<string>(paths) : new Set<string>())
      say(
        `${mode === 'cut' ? 'Cut' : 'Copied'} ${paths.length === 1 ? `“${baseName(paths[0] ?? '')}”` : `${paths.length} items`}`,
      )
    })
  }

  // ---- opening ----------------------------------------------------------------------

  const openArchive = (entry: Row, pane: PaneHandle | null) => {
    setArchive({ path: entry.path, listing: null, error: null, busy: false })
    setDialog({ kind: 'archive', entry, pane })
    void api.archiveList(entry.path).then(
      (listing) => setArchive((a) => (a?.path === entry.path ? { ...a, listing } : a)),
      (e: unknown) =>
        setArchive((a) => (a?.path === entry.path ? { ...a, error: errorText(e) } : a)),
    )
  }

  const extract = (entry: Row, dest: string | null, pane: PaneHandle | null) => {
    setArchive((a) => (a === null ? a : { ...a, busy: true }))
    void api.archiveExtract(entry.path, dest).then(
      (out) => {
        setDialog(null)
        setArchive(null)
        say(`Extracted “${baseName(out)}”`, 'success')
        const target = pane ?? activePane()
        if (target !== null) {
          const parent = parentOf(out)
          if (parent === target.path()) {
            target.reload()
            setTimeout(() => target.select([out]), 150)
          } else if (dest !== null) target.go(parent ?? out, { select: [out] })
        }
      },
      (e: unknown) => {
        setArchive((a) => (a === null ? a : { ...a, busy: false }))
        say(errorText(e), 'danger')
      },
    )
  }

  const openExternal = (paths: string[]) =>
    api.launchWith(null, paths).catch((e: unknown) => {
      say(errorText(e), 'danger')
      setDialog({ kind: 'open-with', paths })
    })

  const quickLook = (pane: PaneHandle, entry?: Row) => {
    const target = entry ?? pane.selected()[0]
    if (target === undefined || target.dir) return
    const items = pane.rows().filter((e) => VIEWABLE_KINDS.has(fileKind(e)))
    const index = items.findIndex((e) => e.path === target.path)
    if (index === -1) {
      void openExternal([target.path])
      return
    }
    setViewer({ items, index })
  }

  const open = (entry: Row, pane: PaneHandle, how: 'default' | 'tab' | 'window') => {
    if (pane.mode() === 'trash') {
      say('Restore it first to open it')
      return
    }
    if (entry.dir) {
      if (how === 'tab') openTab(entry.path, { activate: false })
      else if (how === 'window') void api.newWindow([entry.path])
      else pane.go(entry.path)
      return
    }
    const kind = fileKind(entry)
    if (kind === 'archive') {
      openArchive(entry, pane)
      return
    }
    if (
      isExecutable(entry) &&
      (kind === 'other' || kind === 'executable' || kind === 'package' || kind === 'code')
    ) {
      setDialog({ kind: 'run', entry, pane })
      return
    }
    if (kind === 'package' && isAppImage(entry.name)) {
      setDialog({ kind: 'run', entry, pane })
      return
    }
    void openExternal([entry.path])
  }

  const openPlace = (place: FsPlace) => {
    const pane = activePane()
    if (pane === null) return
    if (place.state === 'setup') {
      say(`Sign in to your ewe account in ewe Sync to use ${place.label}`, 'danger')
      return
    }
    if (place.state === 'offline' && place.mount !== undefined) {
      say(`Connect ${place.label} in ewe Sync first`)
      return
    }
    pane.go(place.path)
  }

  const deviceAction = (d: Device, action: 'mount' | 'unmount' | 'eject' | 'open') => {
    if (action === 'open') {
      if (d.path !== null) activePane()?.go(d.path)
      return
    }
    say(
      action === 'mount'
        ? `Connecting ${d.label}…`
        : action === 'eject'
          ? `Ejecting ${d.label}…`
          : `Disconnecting ${d.label}…`,
    )
    void api.deviceAction(d.id, action).catch((e: unknown) => say(errorText(e), 'danger'))
  }

  // ---- editing ----------------------------------------------------------------------

  const newFolder = (pane: PaneHandle) => {
    if (pane.mode() !== 'folder') return
    const name = uniqueName(
      pane.rows().map((e) => e.name),
      'New folder',
    )
    void api.mkdir(pane.path(), name).then(
      (created) => {
        pane.reload()
        setTimeout(() => {
          pane.select([created])
          pane.startRename(created)
        }, 120)
      },
      (e: unknown) => say(errorText(e), 'danger'),
    )
  }

  const newFile = (pane: PaneHandle, template: AppEntry | null) => {
    const base = template === null ? 'New file' : template.name
    const name = uniqueName(
      pane.rows().map((e) => e.name),
      base,
    )
    void api.mkfile(pane.path(), name, template?.path ?? null).then(
      (created) => {
        pane.reload()
        setTimeout(() => {
          pane.select([created])
          pane.startRename(created)
        }, 120)
      },
      (e: unknown) => say(errorText(e), 'danger'),
    )
  }

  const commitRename = (pane: PaneHandle, entry: Row, name: string) => {
    const next = name.trim()
    if (next === '' || next === entry.name) return
    if (!isFileName(next)) {
      say('A name cannot contain /', 'danger')
      return
    }
    void api.rename(entry.path, next).then(
      (renamed) => {
        pane.reload()
        setTimeout(() => pane.select([renamed]), 120)
      },
      (e: unknown) => say(errorText(e), 'danger'),
    )
  }

  const renameMany = (pane: PaneHandle, pairs: { path: string; name: string }[]) => {
    setDialog(null)
    void (async () => {
      let failed = 0
      for (const p of pairs) {
        try {
          await api.rename(p.path, p.name)
        } catch {
          failed++
        }
      }
      pane.reload()
      say(
        failed === 0
          ? `Renamed ${pairs.length} items`
          : `Renamed ${pairs.length - failed}, ${failed} failed`,
        failed === 0 ? 'success' : 'danger',
      )
    })()
  }

  const copyPath = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => say('Path copied'),
      () => say('Could not copy the path', 'danger'),
    )

  const compress = (paths: string[], name: string, format: CompressFormat, pane: PaneHandle) => {
    setDialog(null)
    say('Compressing…')
    void api.archiveCompress(paths, format, name).then(
      (out) => {
        say(`Created “${baseName(out)}”`, 'success')
        pane.reload()
        setTimeout(() => pane.select([out]), 150)
      },
      (e: unknown) => say(errorText(e), 'danger'),
    )
  }

  // ---- menus --------------------------------------------------------------------------

  const syncItem = (p: string): MenuEntry | null => {
    if (!eweSync()) return null
    const action = syncAction(p, places(), home())
    if (action === 'keep')
      return item(
        'sync-keep',
        'Keep in your account…',
        'cloud',
        () =>
          void api
            .eweSync('add-folder', { path: p })
            .then((ok) =>
              say(ok ? 'Opening ewe Sync…' : 'Could not open ewe Sync', ok ? 'info' : 'danger'),
            ),
      )
    if (action === 'settings')
      return item('sync-settings', 'Sync settings…', 'refresh-cw', openSyncSettings)
    return null
  }
  const openSyncSettings = () =>
    void api.eweSync('pane', { pane: 'folders' }).then((ok) => {
      if (!ok) say('ewe Sync is not installed', 'danger')
    })

  const entryMenu = (pane: PaneHandle, entry: Row, at: Point) => {
    const sel = pane.selected()
    const paths = sel.map((e) => e.path)
    const many = paths.length > 1
    const kind = fileKind(entry)
    const items: MenuEntry[] = []
    if (pane.mode() === 'trash') {
      items.push(
        item('restore', 'Restore', 'rotate-ccw', () => startOp('restore', paths, null)),
        item('delete', 'Delete forever', 'trash-2', () => confirmDelete(paths), { danger: true }),
        sep(),
        item('props', 'Properties', 'info', () => setDialog({ kind: 'properties', paths })),
      )
      setMenu({ at, items })
      return
    }
    items.push(
      item(
        'open',
        'Open',
        entry.dir ? 'folder-open' : 'external-link',
        () => open(entry, pane, 'default'),
        { disabled: many },
      ),
    )
    if (entry.dir) {
      items.push(
        item(
          'open-tab',
          'Open in new tab',
          'plus',
          () => openTab(entry.path, { activate: false }),
          { disabled: many },
        ),
        item(
          'open-window',
          'Open in new window',
          'app-window',
          () => void api.newWindow([entry.path]),
          { disabled: many },
        ),
      )
      const other = otherPane()
      if (other !== null && !many)
        items.push(
          item('open-other', 'Open in the other pane', 'columns-2', () => other.go(entry.path)),
        )
    } else {
      if (!many && VIEWABLE_KINDS.has(kind))
        items.push(
          item('look', 'Quick look', 'eye', () => quickLook(pane, entry), { hint: 'Space' }),
        )
      items.push(
        item('open-with', 'Open with…', 'app-window', () =>
          setDialog({ kind: 'open-with', paths }),
        ),
      )
      if (!many && kind === 'archive') {
        items.push(
          item('extract', 'Extract here', 'archive', () => extract(entry, null, pane)),
          item('extract-to', 'Extract to…', 'folder-open', () =>
            setDialog({ kind: 'extract-to', entry, pane }),
          ),
        )
      }
      if (!many && (isExecutable(entry) || isAppImage(entry.name)))
        items.push(item('run', 'Run…', 'play', () => setDialog({ kind: 'run', entry, pane })))
      if (!many && (kind === 'image' || kind === 'video') && (tools()?.eweConf ?? false))
        items.push(
          item(
            'wallpaper',
            'Set as wallpaper',
            'image',
            () =>
              void api.setWallpaper(entry.path).then(
                () => say('Wallpaper set', 'success'),
                (e: unknown) => say(errorText(e), 'danger'),
              ),
          ),
        )
    }
    items.push(
      item('compress', 'Compress…', 'archive', () => setDialog({ kind: 'compress', paths, pane })),
    )
    items.push(
      sep(),
      item('cut', 'Cut', 'scissors', () => setClip('cut', paths), { hint: 'Ctrl+X' }),
      item('copy', 'Copy', 'copy', () => setClip('copy', paths), { hint: 'Ctrl+C' }),
    )
    if (entry.dir && !many)
      items.push(item('paste-into', 'Paste into folder', 'clipboard', () => pasteInto(entry.path)))
    const other = otherPane()
    if (other !== null && other.mode() === 'folder')
      items.push(
        item('copy-other', `Copy to “${baseName(other.path()) || '/'}”`, 'columns-2', () =>
          startOp('copy', paths, other.path()),
        ),
        item('move-other', `Move to “${baseName(other.path()) || '/'}”`, 'columns-2', () =>
          startOp('move', paths, other.path()),
        ),
      )
    items.push(
      sep(),
      many
        ? item(
            'rename-many',
            'Rename…',
            'square-pen',
            () => setDialog({ kind: 'rename-many', entries: sel, pane }),
            { hint: 'F2' },
          )
        : item('rename', 'Rename', 'pencil', () => pane.startRename(entry.path), { hint: 'F2' }),
      item('link', many ? 'Create links' : 'Create link', 'link', () => {
        void Promise.all(paths.map((p) => api.link(p, pane.path()))).then(
          () => pane.reload(),
          (e: unknown) => say(errorText(e), 'danger'),
        )
      }),
      item('copy-path', many ? 'Copy paths' : 'Copy path', 'copy', () =>
        copyPath(paths.join('\n')),
      ),
    )
    if (entry.dir && !many)
      items.push(
        item(
          'terminal',
          'Open in Terminal',
          'terminal',
          () =>
            void api.openTerminal(entry.path).catch((e: unknown) => say(errorText(e), 'danger')),
        ),
      )
    const sync = entry.dir && !many ? syncItem(entry.path) : null
    if (sync !== null) items.push(sep(), sync)
    items.push(
      sep(),
      item('trash', 'Move to Trash', 'trash-2', () => trashSelected(pane, paths), {
        hint: 'Del',
        danger: true,
      }),
      item('delete', 'Delete forever', 'trash-2', () => confirmDelete(paths), {
        hint: 'Shift+Del',
        danger: true,
      }),
      sep(),
      item('props', 'Properties', 'info', () => setDialog({ kind: 'properties', paths }), {
        hint: 'Alt+Enter',
      }),
    )
    setMenu({ at, items })
  }

  const [templates, setTemplates] = createSignal<AppEntry[]>([])

  const backgroundMenu = (pane: PaneHandle, at: Point) => {
    if (pane.mode() === 'trash') {
      setMenu({
        at,
        items: [
          item('empty', 'Empty Trash', 'trash-2', () => emptyTrash(), {
            danger: true,
            disabled: trashRows().length === 0,
          }),
          item('select-all', 'Select all', 'check', () => pane.selectAll(), { hint: 'Ctrl+A' }),
        ],
      })
      return
    }
    const writable = pane.listing()?.writable ?? false
    const sync = syncItem(pane.path())
    const p = prefsFor(pane.path())
    const newFileItems: MenuEntry[] = [
      item('new-empty', 'Empty file', 'file', () => newFile(pane, null)),
      ...(templates().length > 0
        ? [
            sep(),
            ...templates().map((t) =>
              item(`tpl-${t.path}`, t.name, 'file-text', () => newFile(pane, t)),
            ),
          ]
        : []),
    ]
    setMenu({
      at,
      items: [
        item('new-folder', 'New folder', 'folder-plus', () => newFolder(pane), {
          hint: 'Ctrl+Shift+N',
          disabled: !writable,
        }),
        {
          type: 'item',
          id: 'new-file',
          label: 'New file',
          icon: 'file-plus',
          disabled: !writable,
          items: newFileItems,
        },
        item('paste', 'Paste', 'clipboard', () => pasteInto(pane.path()), {
          hint: 'Ctrl+V',
          disabled: !writable,
        }),
        sep(),
        item('select-all', 'Select all', 'check', () => pane.selectAll(), { hint: 'Ctrl+A' }),
        item(
          'hidden',
          p.hidden ? 'Hide hidden files' : 'Show hidden files',
          p.hidden ? 'eye-off' : 'eye',
          () => setPref(pane.path(), { hidden: !p.hidden }),
          { hint: 'Ctrl+H' },
        ),
        {
          type: 'item',
          id: 'view',
          label: 'View',
          icon: p.view === 'grid' ? 'layout-grid' : 'list',
          items: [
            item(
              'view-grid',
              'Grid',
              p.view === 'grid' ? 'check' : null,
              () => setPref(pane.path(), { view: 'grid' }),
              { hint: 'Ctrl+1' },
            ),
            item(
              'view-list',
              'List',
              p.view === 'list' ? 'check' : null,
              () => setPref(pane.path(), { view: 'list' }),
              { hint: 'Ctrl+2' },
            ),
            sep(),
            ...SORT_KEYS.map((k) =>
              item(
                `sort-${k}`,
                `Sort by ${SORT_LABELS[k].toLowerCase()}`,
                p.sort === k ? 'check' : null,
                () => setPref(pane.path(), { sort: k }),
              ),
            ),
            item('desc', 'Descending', p.desc ? 'check' : null, () =>
              setPref(pane.path(), { desc: !p.desc }),
            ),
          ],
        },
        sep(),
        item(
          'terminal',
          'Open in Terminal',
          'terminal',
          () =>
            void api.openTerminal(pane.path()).catch((e: unknown) => say(errorText(e), 'danger')),
        ),
        item('copy-path', 'Copy path', 'copy', () => copyPath(pane.path())),
        item('props', 'Properties', 'info', () =>
          setDialog({ kind: 'properties', paths: [pane.path()] }),
        ),
        ...(sync === null ? [] : [sep(), sync]),
      ],
    })
  }

  const sortMenu = (pane: PaneHandle, at: Point) => {
    const p = prefsFor(pane.path())
    setMenu({
      at,
      items: [
        ...SORT_KEYS.map((k) =>
          item(`sort-${k}`, SORT_LABELS[k], p.sort === k ? 'check' : null, () =>
            setPref(pane.path(), { sort: k }),
          ),
        ),
        sep(),
        item('desc', 'Descending', p.desc ? 'check' : null, () =>
          setPref(pane.path(), { desc: !p.desc }),
        ),
      ],
    })
  }

  const placeMenu = (target: { place?: FsPlace; device?: Device }, at: Point) => {
    const items: MenuEntry[] = []
    const place = target.place
    const d = target.device
    if (place !== undefined) {
      items.push(
        item('open', 'Open', 'folder-open', () => openPlace(place)),
        item('open-tab', 'Open in new tab', 'plus', () => openTab(place.path, { activate: false })),
        item(
          'open-window',
          'Open in new window',
          'app-window',
          () => void api.newWindow([place.path]),
        ),
      )
      if (place.path === TRASH_PATH)
        items.push(
          sep(),
          item('empty', 'Empty Trash', 'trash-2', () => emptyTrash(), {
            danger: true,
            disabled: trashRows().length === 0,
          }),
        )
      else
        items.push(
          sep(),
          item('props', 'Properties', 'info', () =>
            setDialog({ kind: 'properties', paths: [place.path] }),
          ),
        )
      const dev = devices().find((x) => x.path === place.path)
      if (dev?.mounted === true) {
        if (dev.canUnmount)
          items.push(item('unmount', 'Disconnect', 'eject', () => deviceAction(dev, 'unmount')))
        if (dev.canEject)
          items.push(item('eject', 'Eject safely', 'eject', () => deviceAction(dev, 'eject')))
      }
    } else if (d !== undefined) {
      if (d.mounted) {
        items.push(item('open', 'Open', 'folder-open', () => deviceAction(d, 'open')))
        if (d.canUnmount)
          items.push(item('unmount', 'Disconnect', 'eject', () => deviceAction(d, 'unmount')))
        if (d.canEject)
          items.push(item('eject', 'Eject safely', 'eject', () => deviceAction(d, 'eject')))
      } else if (d.canMount)
        items.push(item('mount', 'Connect', 'plug', () => deviceAction(d, 'mount')))
    }
    setMenu({ at, items })
  }

  const emptyTrash = () =>
    setDialog({
      kind: 'confirm',
      title: 'Empty Trash?',
      description: `${trashRows().length} item${trashRows().length === 1 ? '' : 's'} will be deleted for good.`,
      action: 'Empty Trash',
      danger: true,
      run: () => {
        setDialog(null)
        startOp('empty-trash', [], null)
      },
    })

  const tabMenu = (id: string, at: Point) => {
    const t = tabs.find((x) => x.id === id)
    if (t === undefined) return
    setMenu({
      at,
      items: [
        item('dup', 'Duplicate tab', 'copy', () => {
          const p = panes.get(t.panes[t.active] ?? '')
          if (p !== undefined) openTab(p.path())
        }),
        item(
          'split',
          t.panes.length > 1 ? 'Close split view' : 'Split view',
          'columns-2',
          () => {
            setActiveTab(id)
            splitToggle()
          },
          { hint: 'F3' },
        ),
        item('window', 'Move to new window', 'app-window', () => {
          const p = panes.get(t.panes[t.active] ?? '')
          if (p !== undefined) {
            void api.newWindow([p.path()])
            closeTab(id)
          }
        }),
        sep(),
        item('close', 'Close tab', 'x', () => closeTab(id), { hint: 'Ctrl+W' }),
        item(
          'close-others',
          'Close other tabs',
          null,
          () => {
            for (const o of [...tabs]) if (o.id !== id) closeTab(o.id)
          },
          { disabled: tabs.length < 2 },
        ),
      ],
    })
  }

  // ---- drag and drop -------------------------------------------------------------------

  const startDrag = (pane: PaneHandle, _entry: Row, e: DragEvent) => {
    const paths = pane.selected().map((x) => x.path)
    dragPaths = paths
    if (e.dataTransfer === null) return
    const uris = paths.map((p) => `file://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`)
    e.dataTransfer.setData('text/uri-list', uris.join('\r\n'))
    e.dataTransfer.setData('text/plain', paths.join('\n'))
    e.dataTransfer.setData('application/x-ewe-files', JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const dropOn = (dir: string, paths: string[], copy: boolean) => {
    setDropTarget(null)
    if (dir === TRASH_PATH) {
      const pane = activePane()
      if (pane !== null) trashSelected(pane, paths)
      return
    }
    const sources = paths.filter((p) => parentOf(p) !== dir && p !== dir)
    if (sources.length === 0) return
    startOp(copy ? 'copy' : 'move', sources, dir)
  }

  const onDomDrop = (dir: string, e: DragEvent) => {
    lastDomDrop = Date.now()
    const own = e.dataTransfer?.getData('application/x-ewe-files') ?? ''
    let paths: string[]
    if (own !== '') {
      try {
        paths = JSON.parse(own) as string[]
      } catch {
        paths = dragPaths ?? []
      }
    } else {
      const uris = e.dataTransfer?.getData('text/uri-list') ?? ''
      paths = uris
        .split(/\r?\n/)
        .filter((u) => u.startsWith('file://'))
        .map((u) => decodeURIComponent(u.slice(7)))
    }
    dragPaths = null
    dropOn(dir, paths, e.ctrlKey)
  }

  let ctrlHeld = false

  // ---- keys -----------------------------------------------------------------------------

  const onKey = (e: KeyboardEvent) => {
    ctrlHeld = e.ctrlKey
    if (menu() !== null || dialog() !== null || viewer() !== null) return
    const pane = activePane()
    if (pane === null) return
    const ctrl = e.ctrlKey || e.metaKey
    const target = e.target as HTMLElement | null
    const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
    // keys that work everywhere
    if (ctrl && e.key === 't') openTab(pane.path() === TRASH_PATH ? home() : pane.path())
    else if (ctrl && e.key === 'w') closeTab(activeTab())
    else if (ctrl && e.key === 'n') void api.newWindow([pane.path()])
    else if (ctrl && e.key === 'Tab') {
      const list = tabs
      const i = list.findIndex((t) => t.id === activeTab())
      const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]
      if (next !== undefined) setActiveTab(next.id)
    } else if (ctrl && e.key >= '1' && e.key <= '9' && e.altKey) {
      const t = tabs[Number(e.key) - 1]
      if (t !== undefined) setActiveTab(t.id)
    } else if (e.key === 'F3') splitToggle()
    else if (e.key === 'F9') togglePreview()
    else if (e.key === 'Escape' && placesDrawer()) setPlacesDrawer(false)
    else if (e.key === 'Escape' && previewOverlay()) setPreviewOverlay(false)
    else if (ctrl && e.key === 'l') pane.editPath()
    else if (ctrl && e.key === 'f' && !e.shiftKey) pane.focusFilter()
    else if (ctrl && e.key === 'F') setSearchOpen(true)
    else if (e.key === 'F5' || (ctrl && e.key === 'r')) pane.reload()
    else if (ctrl && e.key === 'h') setPref(pane.path(), { hidden: !prefsFor(pane.path()).hidden })
    else if (ctrl && (e.key === '=' || e.key === '+')) zoom(pane, 1)
    else if (ctrl && e.key === '-') zoom(pane, -1)
    else if (ctrl && e.key === '0') setPref(pane.path(), { zoom: 96 })
    else if (ctrl && e.key === '1') setPref(pane.path(), { view: 'grid' })
    else if (ctrl && e.key === '2') setPref(pane.path(), { view: 'list' })
    else if (ctrl && e.key === 'z' && !inInput) void undo()
    else if (ctrl && e.shiftKey && e.key === 'N' && !inInput) newFolder(pane)
    else if (e.altKey && e.key === 'ArrowUp') pane.up()
    else if (e.altKey && e.key === 'ArrowLeft') pane.back()
    else if (e.altKey && e.key === 'ArrowRight') pane.forward()
    else if (e.altKey && e.key === 'Home') pane.go(home())
    else if (e.altKey && e.key === 'Enter' && !inInput) {
      const sel = pane.selected()
      setDialog({
        kind: 'properties',
        paths: sel.length > 0 ? sel.map((x) => x.path) : [pane.path()],
      })
    } else if (inInput || pane.hasFocusInInput()) return
    // keys for the list
    else if (e.key === 'ArrowDown') pane.moveSelection(pane.columns(), e.shiftKey)
    else if (e.key === 'ArrowUp') pane.moveSelection(-pane.columns(), e.shiftKey)
    else if (e.key === 'ArrowRight' && prefsFor(pane.path()).view === 'grid')
      pane.moveSelection(1, e.shiftKey)
    else if (e.key === 'ArrowLeft' && prefsFor(pane.path()).view === 'grid')
      pane.moveSelection(-1, e.shiftKey)
    else if (e.key === 'Home') pane.moveSelection(-100000, e.shiftKey)
    else if (e.key === 'End') pane.moveSelection(100000, e.shiftKey)
    else if (e.key === 'Enter') {
      const first = pane.selected()[0]
      if (first !== undefined) open(first, pane, ctrl ? 'tab' : 'default')
    } else if (e.key === ' ') quickLook(pane)
    else if (e.key === 'Backspace') pane.back()
    else if (e.key === 'Delete' && e.shiftKey) confirmDelete(pane.selected().map((x) => x.path))
    else if (e.key === 'Delete')
      trashSelected(
        pane,
        pane.selected().map((x) => x.path),
      )
    else if (e.key === 'F2') {
      const sel = pane.selected()
      if (sel.length > 1) setDialog({ kind: 'rename-many', entries: sel, pane })
      else pane.startRename()
    } else if (ctrl && e.key === 'a') pane.selectAll()
    else if (ctrl && e.key === 'c')
      setClip(
        'copy',
        pane.selected().map((x) => x.path),
      )
    else if (ctrl && e.key === 'x')
      setClip(
        'cut',
        pane.selected().map((x) => x.path),
      )
    else if (ctrl && e.key === 'v') pasteInto(pane.path())
    else if (e.key === 'Escape') {
      if (pane.isSearching()) pane.stopSearch()
      else if (!pane.clearFilter()) pane.select([])
    } else if (e.key.length === 1 && !ctrl && !e.altKey) pane.focusFilter(e.key)
    else return
    e.preventDefault()
  }

  const zoom = (pane: PaneHandle, delta: number) => {
    const z = prefsFor(pane.path()).zoom
    const i = Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + delta))
    setPref(pane.path(), { zoom: ZOOMS[i] ?? 96 })
  }

  // ---- launches ----------------------------------------------------------------------------

  const applyLaunch = async (l: Launch, fresh: boolean) => {
    const flagValue = (name: string): string | null => {
      const f = l.flags.find((x) => x === name || x.startsWith(`${name}=`))
      if (f === undefined) return null
      const eq = f.indexOf('=')
      return eq === -1 ? '' : f.slice(eq + 1)
    }
    const selectFlag = flagValue('--select')
    const openWith = flagValue('--open-with')
    const props = flagValue('--properties')
    const paths = [...l.paths]
    if (selectFlag !== null && selectFlag !== '') paths.push(selectFlag)
    if (openWith !== null && openWith !== '') {
      setDialog({ kind: 'open-with', paths: [openWith] })
      if (paths.length === 0) paths.push(parentOf(openWith) ?? '/')
    }
    if (props !== null && paths.length > 0) setDialog({ kind: 'properties', paths: [...paths] })
    if (paths.length === 0) {
      if (fresh) openTab(home())
      return
    }
    const selectMode = selectFlag !== null || props !== null
    let first = true
    for (const p of paths) {
      let info: { type: string } | null
      try {
        info = await api.mimeOf(p)
      } catch {
        info = null
      }
      const isDir = info?.type === 'inode/directory'
      if (isDir && !selectMode) openTab(p, { activate: first })
      else {
        const parent = parentOf(p) ?? '/'
        openTab(parent, { activate: first, select: [p] })
        if (!selectMode && !isDir && fileKind(emptyRow(p)) === 'archive')
          openArchive(emptyRow(p), null)
        else if (!selectMode && !isDir && openWith === null) void openExternal([p])
      }
      first = false
    }
  }

  // `--shot=<scene>`: put the window into a state for scripts/shot.sh (screenshots)
  const runShot = (scene: string) => {
    const after = (ms: number, f: () => void) => setTimeout(f, ms)
    after(600, () => {
      const pane = activePane()
      if (pane === null) return
      const rows = pane.rows()
      const first = rows.find((r) => !r.dir) ?? rows[0]
      const pick = (name: string) => rows.find((r) => r.name === name) ?? first
      switch (scene) {
        case 'list':
          setPref(pane.path(), { view: 'list' })
          if (first !== undefined) pane.select([first.path])
          break
        case 'split':
          splitToggle()
          after(400, () => otherPane()?.go(joinHome('Documents')))
          break
        case 'menu':
          if (first !== undefined) {
            pane.select([first.path])
            entryMenu(pane, first, { x: 420, y: 230 })
          }
          break
        case 'copy': {
          const src = pick('archlinux-2026.11.iso')
          if (src !== undefined) {
            void api.opStart('copy', [src.path], joinHome('Documents')).then((id) => {
              refreshOps()
              setOpsOpen(true)
              after(40, () => void api.opPause(id))
            })
          }
          break
        }
        case 'conflict': {
          const src = pick('Reports.zip')
          if (src !== undefined) startOp('copy', [src.path], joinHome('Documents'))
          break
        }
        case 'properties':
          if (first !== undefined) {
            pane.select([first.path])
            setDialog({ kind: 'properties', paths: [first.path] })
          }
          break
        case 'openwith':
          if (first !== undefined) {
            pane.select([first.path])
            setDialog({ kind: 'open-with', paths: [first.path] })
          }
          break
        case 'archive': {
          const a = pick('Reports.zip')
          if (a !== undefined) openArchive(a, pane)
          break
        }
        case 'trash':
          pane.go(TRASH_PATH)
          break
        case 'quicklook': {
          // the row `--select=` picked, else the fixture's usual suspects
          const img =
            pane.selected()[0] ??
            rows.find((r) => r.name === 'sunset.png' || r.name === 'README.md') ??
            first
          if (img !== undefined) {
            pane.select([img.path])
            quickLook(pane, img)
          }
          break
        }
        case 'search':
          setSearchOpen(true)
          after(200, () =>
            pane.startSearch(
              { query: 'report', kind: '', days: 0, minSize: 0, maxSize: 0, hidden: false },
              false,
            ),
          )
          break
        case 'ops-preview': {
          setPref(pane.path(), { view: 'list' })
          showPreview()
          const src = pick('archlinux-2026.11.iso')
          if (src !== undefined) {
            pane.select([src.path])
            void api.opStart('copy', [src.path], joinHome('Documents')).then((id) => {
              refreshOps()
              setOpsOpen(true)
              after(40, () => void api.opPause(id))
            })
          }
          break
        }
        case 'split-list':
          setPref(pane.path(), { view: 'list' })
          splitToggle()
          after(400, () => {
            const o = otherPane()
            if (o !== null) {
              setPref(joinHome('Documents'), { view: 'list' })
              o.go(joinHome('Documents'))
            }
          })
          break
        case 'grid':
          setPref(pane.path(), { view: 'grid' })
          break
        case 'grid-preview':
          setPref(pane.path(), { view: 'grid' })
          showPreview()
          if (first !== undefined) pane.select([first.path])
          break
        case 'rename':
          pane.selectAll()
          after(100, () => setDialog({ kind: 'rename-many', entries: pane.selected(), pane }))
          break
        case 'preview': {
          showPreview()
          const row = pane.selected()[0] ?? first
          if (row !== undefined) pane.select([row.path])
          break
        }
        case 'places':
          if (compact()) setPlacesDrawer(true)
          break
        case 'more':
          document.querySelector<HTMLElement>('.fm-more-btn')?.click()
          break
        case 'tabs':
          for (const name of ['Documents', 'Pictures', 'Music', 'Downloads'])
            openTab(joinHome(name), { activate: name === 'Music' })
          break
        case 'compress':
          if (first !== undefined) {
            pane.select([first.path])
            setDialog({ kind: 'compress', paths: [first.path], pane })
          }
          break
        default:
          break
      }
    })
  }
  const joinHome = (name: string) => `${home()}/${name}`

  onMount(() => {
    void getMediaServer().then(setServer)
    void api.tools().then(setTools)
    void api.templates().then(setTemplates)
    void api.eweSync('available').then(setEweSync)
    refreshPlaces()
    refreshDevices()
    refreshTrash()
    refreshOps()
    void api.windowLaunch().then((l) =>
      applyLaunch(l, true).then(() => {
        applyShotSize(l.flags)
        const shot = l.flags.find((f) => f.startsWith('--shot='))
        if (shot !== undefined) runShot(shot.slice(7))
      }),
    )
    const offs = [
      onEvent('launch', (l) => void applyLaunch(l, false)),
      onEvent('op-progress', (p) => {
        if (p.window !== label) return
        setOps((list) => {
          const i = list.findIndex((o) => o.id === p.id)
          if (i === -1) return [...list, p]
          const next = [...list]
          next[i] = p
          return next
        })
        if (p.state === 'done') {
          if (p.kind !== 'copy' && p.kind !== 'move') refreshTrash()
          for (const pane of panes.values()) {
            const dest = p.results[0] === undefined ? null : parentOf(p.results[0])
            if (
              pane.mode() === 'trash' ||
              pane.path() === dest ||
              p.kind === 'restore' ||
              p.kind === 'move'
            )
              pane.reload()
          }
          if (p.kind === 'copy' || p.kind === 'move') {
            const n = p.results.length
            toast(
              `${p.kind === 'copy' ? 'Copied' : 'Moved'} ${n === 1 ? `“${baseName(p.results[0] ?? '')}”` : `${n} items`}`,
              {
                kind: 'success',
                ...(p.undoable ? { action: { label: 'Undo', run: () => void undo() } } : {}),
              },
            )
          }
        } else if (p.state === 'failed') say(p.error ?? 'Something went wrong', 'danger')
      }),
      onEvent('devices-changed', () => {
        refreshDevices()
        refreshPlaces()
      }),
      onEvent('device-result', (r) => {
        if (r.ok) {
          if (r.action === 'mount' || r.action === 'connect') {
            say(r.action === 'connect' ? 'Connected' : 'Connected', 'success')
            if (r.path !== null && r.path !== undefined) activePane()?.go(r.path)
          } else say(r.action === 'eject' ? 'Safe to remove' : 'Disconnected', 'success')
          refreshDevices()
          refreshPlaces()
        } else if (r.cancelled !== true) say(r.error ?? 'Could not do that', 'danger')
      }),
      onEvent('mount-ask', (ask) => setDialog({ kind: 'credentials', ask })),
      onEvent('mount-question', (q) => setDialog({ kind: 'question', q })),
    ]
    const onFocus = () => {
      refreshPlaces()
      refreshDevices()
    }
    const clearDrag = () => {
      dragPaths = null
      setDropTarget(null)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', (e) => {
      ctrlHeld = e.ctrlKey
    })
    window.addEventListener('dragend', clearDrag)
    window.addEventListener('pointerdown', (e) => {
      setDropTarget(null)
      const t = e.target as HTMLElement | null
      if (opsOpen() && t?.closest('.ops, .fm-ops-btn, .fm-more-btn') === null) setOpsOpen(false)
      if (placesDrawer() && t?.closest('.fm-places, .fm-places-btn') === null)
        setPlacesDrawer(false)
    })
    window.addEventListener('beforeunload', () => void api.windowClosed())
    // drops from other apps (and our own uri-list drags) come through Tauri
    let offDrop: (() => void) | null = null
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'over') {
          const el = document.elementFromPoint(
            p.position.x / window.devicePixelRatio,
            p.position.y / window.devicePixelRatio,
          )
          const dir = el?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null
          setDropTarget(dir)
        } else if (p.type === 'drop') {
          if (Date.now() - lastDomDrop < 400) return
          const el = document.elementFromPoint(
            p.position.x / window.devicePixelRatio,
            p.position.y / window.devicePixelRatio,
          )
          const dir = el?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? activePath()
          dropOn(dir, p.paths, ctrlHeld)
          dragPaths = null
        } else setDropTarget(null)
      })
      .then((off) => {
        offDrop = off
      })
    onCleanup(() => {
      for (const off of offs) off()
      offDrop?.()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragend', clearDrag)
    })
  })

  // the conflict of the oldest waiting op of this window
  const waiting = createMemo(
    () => ops().find((o) => o.state === 'waiting' && o.conflict !== null) ?? null,
  )
  const running = createMemo(() =>
    ops().some((o) => ['queued', 'running', 'paused', 'waiting'].includes(o.state)),
  )

  const paneCtx: PaneCtx = {
    prefsFor,
    setPref,
    places,
    home,
    thumbUrl: thumb,
    pdfThumb: (path) => (server() === null ? Promise.resolve(null) : pdfThumb(raw(path), 256)),
    open,
    entryMenu,
    backgroundMenu,
    sortMenu,
    menu: (items, at) => setMenu({ at, items }),
    dropTarget,
    setDropTarget,
    onDomDrop,
    startDrag,
    cutPaths,
    say,
    commitRename,
    newFolder,
    trashRows,
    refreshTrash,
    eweSync,
    openSyncSettings,
  }

  const tabItems = createMemo<TabItem[]>(() =>
    tabs.map((t) => ({
      id: t.id,
      label: t.title,
      icon: t.panes.length > 1 ? 'columns-2' : 'folder',
      hint: panes.get(t.panes[t.active] ?? '')?.path(),
    })),
  )

  const previewRow = () => {
    const id = activePaneId()
    const rows = id === null ? [] : (selection()[id] ?? [])
    return rows.length === 1 ? (rows[0] ?? null) : null
  }

  // compact windows: Split, Preview, Operations and New window in one ⋯ menu
  const moreMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const split = (currentTab()?.panes.length ?? 1) > 1
    setMenu({
      at: { x: r.right, y: r.bottom + 4 },
      items: [
        item('split', split ? 'Close split view' : 'Split view', 'columns-2', splitToggle, {
          hint: 'F3',
        }),
        item(
          'preview',
          previewShown() ? 'Hide the preview' : 'Preview',
          'panel-right',
          togglePreview,
          { hint: 'F9' },
        ),
        ...(ops().length > 0
          ? [
              item('ops', 'Operations', running() ? 'refresh-cw' : 'circle-check', () =>
                setOpsOpen(true),
              ),
            ]
          : []),
        sep(),
        item(
          'window',
          'New window',
          'app-window',
          () => void api.newWindow([activePath() === TRASH_PATH ? home() : activePath()]),
          { hint: 'Ctrl+N' },
        ),
      ],
    })
  }

  return (
    <div
      class="app fm-app"
      data-size={winSize()}
      ref={(el) => {
        const ro = new ResizeObserver(() => setWinWidth(el.clientWidth))
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      }}
    >
      <header class="fm-tabbar">
        <IconButton
          icon="panel-left"
          class="fm-places-btn"
          label={placesShown() ? 'Hide places' : compact() ? 'Places' : 'Show places'}
          active={placesShown()}
          onClick={togglePlaces}
        />
        <Tabs
          tabs={tabItems()}
          selected={activeTab()}
          label="Open folders"
          class="fm-tabs"
          onSelect={setActiveTab}
          onClose={closeTab}
          onAdd={() =>
            openTab(activePath() === TRASH_PATH || activePath() === '' ? home() : activePath())
          }
          onMenu={(id, at) => tabMenu(id, at)}
        />
        <IconButton
          icon="search"
          label="Search (Ctrl+Shift+F)"
          active={searchOpen()}
          onClick={() => setSearchOpen((s) => !s)}
        />
        <Show
          when={!compact()}
          fallback={
            <IconButton
              icon="ellipsis"
              label="More"
              class={running() ? 'fm-more-btn running' : 'fm-more-btn'}
              onClick={moreMenu}
            />
          }
        >
          <IconButton
            icon="columns-2"
            label="Split view (F3)"
            active={(currentTab()?.panes.length ?? 1) > 1}
            onClick={splitToggle}
          />
          <IconButton
            icon="panel-right"
            label="Preview pane (F9)"
            active={prefs().preview}
            onClick={togglePreview}
          />
          <Show when={ops().length > 0}>
            <button
              class="iconbtn fm-ops-btn"
              classList={{ running: running(), active: opsOpen() }}
              aria-label="Operations"
              data-tooltip="Operations"
              onClick={() => setOpsOpen((o) => !o)}
            >
              <Icon
                name={running() ? 'refresh-cw' : 'circle-check'}
                class={running() ? 'spin' : ''}
              />
            </button>
          </Show>
          <IconButton
            icon="app-window"
            label="New window (Ctrl+N)"
            onClick={() =>
              void api.newWindow([activePath() === TRASH_PATH ? home() : activePath()])
            }
          />
        </Show>
      </header>
      <div class="fm">
        <Show when={placesShown()}>
          <Places
            drawer={compact()}
            places={places()}
            devices={devices()}
            activePath={activePath()}
            dropTarget={dropTarget()}
            trashCount={trashRows().length}
            onOpen={(place) => {
              setPlacesDrawer(false)
              openPlace(place)
            }}
            onOpenPath={(path, newTab) => {
              setPlacesDrawer(false)
              if (newTab) openTab(path, { activate: false })
              else activePane()?.go(path)
            }}
            onDevice={(d, action) => {
              if (action === 'open' || action === 'mount') setPlacesDrawer(false)
              deviceAction(d, action)
            }}
            onMenu={placeMenu}
            onConnect={() => {
              setPlacesDrawer(false)
              setDialog({ kind: 'connect' })
            }}
            dropHandlers={(dir) => ({
              'data-drop': dir(),
              onDragOver: (e: DragEvent) => {
                e.preventDefault()
                if (e.dataTransfer !== null) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
                setDropTarget(dir())
              },
              onDragLeave: () => {
                if (dropTarget() === dir()) setDropTarget(null)
              },
              onDrop: (e: DragEvent) => {
                e.preventDefault()
                onDomDrop(dir(), e)
              },
            })}
          />
        </Show>
        <div class="fm-main" ref={mainEl}>
          <Show when={searchOpen()}>
            <SearchBar
              plocate={tools()?.plocate ?? false}
              where={baseName(activePath()) || activePath()}
              onSearch={(filters: SearchFilters, everywhere: boolean) =>
                activePane()?.startSearch(filters, everywhere)
              }
              onClose={() => {
                setSearchOpen(false)
                activePane()?.stopSearch()
              }}
            />
          </Show>
          <For each={tabs}>
            {(tab) => (
              <div
                class="fm-tab"
                classList={{ shown: tab.id === activeTab(), split: tab.panes.length > 1 }}
              >
                <For each={tab.panes}>
                  {(paneId) => (
                    <Pane
                      id={paneId}
                      initialPath={paneInit()[paneId]?.path ?? home()}
                      initialSelect={paneInit()[paneId]?.select}
                      ctx={paneCtx}
                      active={tab.panes.length === 1 || tab.panes[tab.active] === paneId}
                      onActivate={() => activatePane(tab.id, paneId)}
                      onPath={(path, title) => {
                        if (tab.panes[tab.active] === paneId || tab.panes.length === 1)
                          setTabs((t) => t.id === tab.id, 'title', title)
                      }}
                      onReady={(h) => panes.set(paneId, h)}
                      onSelection={(rows) => setSelection((s) => ({ ...s, [paneId]: rows }))}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <Show when={previewShown()}>
          <Preview
            row={previewRow()}
            rawUrl={raw}
            pictureUrl={picture}
            readText={readTextFile}
            thumbUrl={thumb}
            onOpen={(r) => void openExternal([r.path])}
            overlay={compact()}
            onClose={() => setPreviewOverlay(false)}
          />
        </Show>
        <Show when={opsOpen() && ops().length > 0}>
          <OpsPanel
            ops={ops()}
            onPause={(id) => void api.opPause(id)}
            onResume={(id) => void api.opResume(id)}
            onCancel={(id) => void api.opCancel(id)}
            onDismiss={(id) => {
              void api.opDismiss(id)
              setOps((l) => l.filter((o) => o.id !== id))
            }}
            onClear={() => {
              for (const o of ops())
                if (['done', 'failed', 'cancelled'].includes(o.state)) void api.opDismiss(o.id)
              setOps((l) => l.filter((o) => !['done', 'failed', 'cancelled'].includes(o.state)))
            }}
            onClose={() => setOpsOpen(false)}
          />
        </Show>
      </div>

      <Show when={viewer()}>
        {(v) => (
          <Viewer
            items={v().items}
            index={v().index}
            rawUrl={raw}
            pictureUrl={picture}
            readText={readTextFile}
            onIndex={(index) => {
              setViewer({ items: v().items, index })
              const current = v().items[index]
              if (current !== undefined) activePane()?.select([current.path])
            }}
            onClose={() => {
              setViewer(null)
              activePane()?.focus()
            }}
            onExternal={(entry) => void openExternal([entry.path])}
            onLink={(href) => copyPath(href)}
          />
        )}
      </Show>

      <Show when={waiting()}>
        {(op) => (
          <ConflictDialog
            op={op()}
            onChoose={(choice, all) => void api.opResolve(op().id, choice, all)}
          />
        )}
      </Show>

      <Show when={dialog()}>
        {(d) => (
          <Switch>
            <Match when={d().kind === 'properties' && d()}>
              {(x) => (
                <PropertiesDialog
                  paths={(x() as { paths: string[] }).paths}
                  mediaThumb={(p) => thumb(p, 256)}
                  onClose={() => setDialog(null)}
                />
              )}
            </Match>
            <Match when={d().kind === 'open-with' && d()}>
              {(x) => (
                <OpenWithDialog
                  paths={(x() as { paths: string[] }).paths}
                  onClose={() => setDialog(null)}
                />
              )}
            </Match>
            <Match when={d().kind === 'connect'}>
              <ConnectDialog
                onConnect={(uri) => {
                  setDialog(null)
                  say(`Connecting to ${uri}…`)
                  void api.connectServer(uri).catch((e: unknown) => say(errorText(e), 'danger'))
                }}
                onClose={() => setDialog(null)}
              />
            </Match>
            <Match when={d().kind === 'credentials' && d()}>
              {(x) => (
                <CredentialsDialog
                  ask={(x() as { ask: MountAsk }).ask}
                  onDone={() => setDialog(null)}
                />
              )}
            </Match>
            <Match when={d().kind === 'question' && d()}>
              {(x) => (
                <QuestionDialog
                  q={(x() as { q: MountQuestion }).q}
                  onDone={() => setDialog(null)}
                />
              )}
            </Match>
            <Match when={d().kind === 'rename-many' && d()}>
              {(x) => {
                const dd = x() as { entries: AppEntry[]; pane: PaneHandle }
                return (
                  <RenameManyDialog
                    entries={dd.entries}
                    onRename={(pairs) => renameMany(dd.pane, pairs)}
                    onClose={() => setDialog(null)}
                  />
                )
              }}
            </Match>
            <Match when={d().kind === 'compress' && d()}>
              {(x) => {
                const dd = x() as { paths: string[]; pane: PaneHandle }
                return (
                  <CompressDialog
                    paths={dd.paths}
                    sevenZip={tools()?.sevenZip ?? false}
                    onCreate={(name, format) => compress(dd.paths, name, format, dd.pane)}
                    onClose={() => setDialog(null)}
                  />
                )
              }}
            </Match>
            <Match when={d().kind === 'run' && d()}>
              {(x) => {
                const dd = x() as { entry: AppEntry; pane: PaneHandle }
                return (
                  <RunDialog
                    entry={dd.entry}
                    komble={tools()?.komble ?? false}
                    onRun={(terminal) => {
                      setDialog(null)
                      void api
                        .runExecutable(dd.entry.path, terminal)
                        .catch((e: unknown) => say(errorText(e), 'danger'))
                    }}
                    onInstall={() => {
                      setDialog(null)
                      void api.komble(dd.entry.path).then(
                        () => say('Komble is opening…'),
                        (e: unknown) => say(errorText(e), 'danger'),
                      )
                    }}
                    onView={() => {
                      setDialog(null)
                      setViewer({ items: [dd.entry], index: 0 })
                    }}
                    onClose={() => setDialog(null)}
                  />
                )
              }}
            </Match>
            <Match when={d().kind === 'archive' && d()}>
              {(x) => {
                const dd = x() as { entry: Row; pane: PaneHandle | null }
                return (
                  <ArchiveDialog
                    name={dd.entry.name}
                    listing={archive()?.listing ?? null}
                    error={archive()?.error ?? null}
                    busy={archive()?.busy ?? false}
                    onExtract={() => extract(dd.entry, null, dd.pane)}
                    onExtractTo={() =>
                      setDialog({ kind: 'extract-to', entry: dd.entry, pane: dd.pane })
                    }
                    onOpenWith={() => setDialog({ kind: 'open-with', paths: [dd.entry.path] })}
                    onClose={() => {
                      setDialog(null)
                      setArchive(null)
                    }}
                  />
                )
              }}
            </Match>
            <Match when={d().kind === 'extract-to' && d()}>
              {(x) => {
                const dd = x() as { entry: Row; pane: PaneHandle | null }
                return (
                  <PathDialog
                    title={`Extract “${dd.entry.name}” to`}
                    description="The folder to unpack into. It is created when it does not exist."
                    action="Extract"
                    initial={otherPane()?.path() ?? parentOf(dd.entry.path) ?? home()}
                    home={home()}
                    onPick={(path) => extract(dd.entry, path, dd.pane)}
                    onClose={() => setDialog(null)}
                  />
                )
              }}
            </Match>
            <Match when={d().kind === 'confirm' && d()}>
              {(x) => {
                const dd = x() as {
                  title: string
                  description: string
                  action: string
                  danger: boolean
                  run(): void
                }
                return (
                  <ConfirmDialog
                    title={dd.title}
                    description={dd.description}
                    action={dd.action}
                    danger={dd.danger}
                    onConfirm={() => dd.run()}
                    onClose={() => setDialog(null)}
                  />
                )
              }}
            </Match>
          </Switch>
        )}
      </Show>

      <Show when={menu()}>
        {(m) => (
          <div
            class="fm-menu-backdrop"
            onMouseDown={(e) => e.target === e.currentTarget && setMenu(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Menu items={m().items} at={m().at} onClose={() => setMenu(null)} />
          </div>
        )}
      </Show>
      <Toasts />
    </div>
  )
}

export { batch }
