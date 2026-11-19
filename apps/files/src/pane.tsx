// One folder view: toolbar (back, forward, up, crumbs → path field, filter, new
// folder, hidden, sort, view), the grid or list, the status line. A tab has one
// pane, or two side by side (split view). Trash and search results are modes of
// the same pane.

import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from 'solid-js'
import {
  THUMBNAIL_KINDS,
  TRASH_PATH,
  baseName,
  fileKind,
  filterEntries,
  formatBytes,
  isExecutable,
  joinPath,
  parentOf,
  sortEntries,
  syncLabel,
  syncRootOf,
  type AppEntry,
  type AppListing,
  type FileKind,
  type FsPlace,
  type FsPlaceSync,
  type Point,
  type SearchFilters,
  type SortKey,
  type TrashEntry,
} from '@ewe/shared'
import { Icon, IconButton, type IconName, type MenuEntry } from '@ewe/ui'
import { api, errorText, on as onEvent, windowLabel } from './api'
import type { ViewPrefs } from './prefs'
import { SYNC_ICON, syncTitle } from './places'

export const KIND_ICON: Record<FileKind, IconName> = {
  folder: 'folder',
  image: 'image',
  video: 'video',
  audio: 'music',
  pdf: 'file-text',
  text: 'file-text',
  code: 'code',
  archive: 'archive',
  document: 'file-text',
  sheet: 'table',
  slides: 'presentation',
  font: 'type',
  disk: 'disc',
  executable: 'terminal',
  package: 'package',
  other: 'file',
}

export const KIND_LABEL: Record<FileKind, string> = {
  folder: 'Folder',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  text: 'Text',
  code: 'Code',
  archive: 'Archive',
  document: 'Document',
  sheet: 'Spreadsheet',
  slides: 'Presentation',
  font: 'Font',
  disk: 'Disk image',
  executable: 'Program',
  package: 'App package',
  other: 'File',
}

export const SORT_KEYS: SortKey[] = ['name', 'mtime', 'size', 'kind']
export const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  mtime: 'Modified',
  size: 'Size',
  kind: 'Type',
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

export function formatDate(ms: number): string {
  if (ms === 0) return ''
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString()
    ? `Today ${timeFormat.format(d)}`
    : dateFormat.format(d)
}

export type PaneMode = 'folder' | 'trash' | 'search'

/** An entry as the pane shows it: trash rows carry where they came from. */
export interface Row extends AppEntry {
  original?: string | undefined
  deleted?: number | undefined
}

export interface PaneHandle {
  id: string
  go(path: string, options?: { push?: boolean; select?: string[] | undefined }): void
  back(): void
  forward(): void
  up(): void
  reload(): void
  path(): string
  mode(): PaneMode
  listing(): AppListing | null
  rows(): Row[]
  selected(): Row[]
  select(paths: string[], anchor?: string): void
  selectAll(): void
  startRename(path?: string): void
  focus(): void
  focusFilter(seed?: string): void
  editPath(): void
  clearFilter(): boolean
  startSearch(filters: SearchFilters, everywhere: boolean): void
  stopSearch(): void
  isSearching(): boolean
  moveSelection(delta: number, shift: boolean): void
  columns(): number
  hasFocusInInput(): boolean
}

export interface PaneCtx {
  prefsFor(path: string): ViewPrefs
  setPref(path: string, patch: Partial<ViewPrefs>): void
  places: Accessor<FsPlace[]>
  home(): string
  thumbUrl(path: string, size: 128 | 256 | 512): string
  pdfThumb(path: string): Promise<string | null>
  open(entry: Row, pane: PaneHandle, how: 'default' | 'tab' | 'window'): void
  entryMenu(pane: PaneHandle, entry: Row, at: Point): void
  backgroundMenu(pane: PaneHandle, at: Point): void
  sortMenu(pane: PaneHandle, at: Point): void
  menu(items: MenuEntry[], at: Point): void
  dropTarget: Accessor<string | null>
  setDropTarget(path: string | null): void
  onDomDrop(dir: string, e: DragEvent): void
  startDrag(pane: PaneHandle, entry: Row, e: DragEvent): void
  cutPaths: Accessor<ReadonlySet<string>>
  say(text: string, kind?: 'info' | 'danger' | 'success'): void
  commitRename(pane: PaneHandle, entry: Row, name: string): void
  newFolder(pane: PaneHandle): void
  trashRows: Accessor<TrashEntry[]>
  refreshTrash(): void
  eweSync: Accessor<boolean>
  openSyncSettings(): void
}

export interface PaneProps {
  id: string
  initialPath: string
  initialSelect?: string[] | undefined
  ctx: PaneCtx
  active: boolean
  onActivate(): void
  onPath(path: string, title: string): void
  onReady(handle: PaneHandle): void
  onSelection(rows: Row[]): void
}

export function Pane(props: PaneProps): JSX.Element {
  const [path, setPath] = createSignal('')
  const [listing, setListing] = createSignal<AppListing | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = createSignal<string | null>(null)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [filter, setFilter] = createSignal('')
  const [editingPath, setEditingPath] = createSignal(false)
  const [history, setHistory] = createSignal<string[]>([])
  const [histIndex, setHistIndex] = createSignal(-1)
  const [search, setSearch] = createSignal<{
    id: number | null
    root: string
    filters: SearchFilters
    items: Row[]
    done: boolean
    everywhere: boolean
  } | null>(null)
  let content: HTMLDivElement | undefined
  // windowing: only the rows near the viewport are in the DOM (a 3000-file folder
  // rendered whole cost WebKit ~500 MB)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal({ width: 0, height: 0 })
  const [measured, setMeasured] = createSignal<{ row: number; cols: number } | null>(null)
  const OVERSCAN = 2
  // the toolbar condenses as the pane narrows (split view, side panels)
  const [paneWidth, setPaneWidth] = createSignal(1280)
  const [filterOpen, setFilterOpen] = createSignal(false)
  const tier = (): 'wide' | 'medium' | 'narrow' =>
    paneWidth() < 560 ? 'narrow' : paneWidth() < 860 ? 'medium' : 'wide'
  const filterShown = () => tier() === 'wide' || filterOpen() || filter() !== ''
  let filterInput: HTMLInputElement | undefined
  let loadSeq = 0

  const ctx = () => props.ctx
  const prefs = () => ctx().prefsFor(path())
  const mode = (): PaneMode =>
    search() !== null ? 'search' : path() === TRASH_PATH ? 'trash' : 'folder'

  const rows = createMemo<Row[]>(() => {
    const s = search()
    if (s !== null) return sortEntries(s.items, prefs().sort, prefs().desc) as Row[]
    if (path() === TRASH_PATH) {
      const list: Row[] = ctx()
        .trashRows()
        .map((t) => ({
          name: t.name,
          path: t.path,
          kind: t.dir ? 'dir' : 'file',
          dir: t.dir,
          size: t.size,
          mtime: t.mtime,
          hidden: false,
          target: null,
          mode: t.mode,
          original: t.original,
          deleted: t.deleted,
        }))
      return sortEntries(filterEntries(list, filter()), prefs().sort, prefs().desc) as Row[]
    }
    return sortEntries(
      filterEntries(listing()?.entries ?? [], filter()),
      prefs().sort,
      prefs().desc,
    ) as Row[]
  })
  const selectedRows = createMemo(() => rows().filter((e) => selected().has(e.path)))
  createEffect(() => props.onSelection(selectedRows()))

  const selectOnly = (p: string) => {
    setSelected(new Set([p]))
    setAnchor(p)
  }

  const titleFor = (p: string): string => {
    if (p === ctx().home()) return 'Home'
    if (p === '/') return 'File system'
    if (p === TRASH_PATH) return 'Trash'
    return (
      ctx()
        .places()
        .find((pl) => pl.path === p)?.label ?? baseName(p)
    )
  }

  const reveal = (p: string) => {
    const el = content
    if (el === undefined) return
    const i = rows().findIndex((r) => r.path === p)
    if (i === -1) return
    const { row, cols } = geometry()
    const top = Math.floor(i / cols) * row + headHeight()
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + row > el.scrollTop + el.clientHeight) el.scrollTop = top + row - el.clientHeight
    queueMicrotask(() =>
      el
        .querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)
        ?.scrollIntoView({ block: 'nearest' }),
    )
  }

  const headHeight = () => (prefs().view === 'list' ? 36 : 0)
  /** Row height and columns: measured from the first rendered item, else estimated. */
  const geometry = (): { row: number; cols: number } => {
    const m = measured()
    if (m !== null && m.cols > 0 && m.row > 0) return m
    if (prefs().view === 'list') return { row: 36, cols: 1 }
    const tile = prefs().zoom + 16
    const width = Math.max(1, viewport().width - 32)
    return {
      row: Math.round(prefs().zoom * 0.67 + 16 + 32 + 8 + (mode() === 'folder' ? 0 : 14)),
      cols: Math.max(1, Math.floor((width + 4) / (tile + 4))),
    }
  }
  const measure = () => {
    const el = content
    if (el === undefined) return
    const items = [...el.querySelectorAll<HTMLElement>('.fm-tile, .fm-row')]
    const first = items[0]
    if (first === undefined) return setMeasured(null)
    const top = first.offsetTop
    const cols =
      prefs().view === 'list' ? 1 : Math.max(1, items.filter((t) => t.offsetTop === top).length)
    const second = items.find((t) => t.offsetTop > top)
    const gap = prefs().view === 'list' ? 0 : 4
    const row = second === undefined ? first.offsetHeight + gap : second.offsetTop - top
    const next = { row, cols }
    const m = measured()
    if (m?.row !== next.row || m.cols !== next.cols) setMeasured(next)
  }
  const window_ = createMemo(() => {
    const total = rows().length
    const { row, cols } = geometry()
    const h = viewport().height || 720
    const firstRow = Math.max(0, Math.floor((scrollTop() - headHeight()) / row) - OVERSCAN)
    const visibleRows = Math.ceil(h / row) + OVERSCAN * 2 + 1
    const start = Math.min(total, firstRow * cols)
    const end = Math.min(total, (firstRow + visibleRows) * cols)
    const totalRows = Math.ceil(total / cols)
    return {
      start,
      end,
      before: firstRow * row,
      after: Math.max(0, (totalRows - firstRow - visibleRows) * row),
    }
  })
  const shown = createMemo(() => rows().slice(window_().start, window_().end))
  createEffect(on([shown, () => prefs().view, () => prefs().zoom], () => queueMicrotask(measure)))
  createEffect(
    on([() => prefs().view, () => prefs().zoom, () => mode()], () => setMeasured(null), {
      defer: true,
    }),
  )

  const load = async (
    target: string,
    options: { push?: boolean; keep?: boolean; select?: string[] | undefined } = {},
  ) => {
    const seq = ++loadSeq
    if (search() !== null) {
      void api.searchStop()
      setSearch(null)
    }
    const previous = path()
    if (target === TRASH_PATH) {
      setError(null)
      setListing(null)
      setPath(TRASH_PATH)
      ctx().refreshTrash()
      void api.watch(props.id, null)
    } else {
      setLoading(true)
      let result: AppListing
      try {
        result = await api.list(target, prefs().hidden || ctx().prefsFor(target).hidden)
      } catch (e) {
        if (seq !== loadSeq) return
        setLoading(false)
        setError(errorText(e))
        setListing(null)
        setPath(target)
        props.onPath(target, baseName(target))
        return
      }
      if (seq !== loadSeq) return
      setLoading(false)
      setError(null)
      setListing(result)
      setPath(result.path)
      void api.watch(props.id, result.path)
    }
    const next = path()
    if (next !== previous) {
      setFilter('')
      setRenaming(null)
      setAnchor(null)
      setEditingPath(false)
    }
    if (options.push === true && next !== previous) {
      const h = history().slice(0, histIndex() + 1)
      h.push(next)
      setHistory(h)
      setHistIndex(h.length - 1)
    }
    const chosen = options.select
    if (chosen !== undefined && chosen.length > 0) {
      const full = chosen.map((c) => (c.startsWith('/') ? c : joinPath(next, c)))
      setSelected(new Set(full))
      setAnchor(full[0] ?? null)
      queueMicrotask(() => {
        const f = full[0]
        if (f !== undefined) reveal(f)
      })
    } else if (options.keep === true) {
      const alive = new Set(rows().map((e) => e.path))
      setSelected(new Set([...selected()].filter((p) => alive.has(p))))
    } else setSelected(new Set<string>())
    props.onPath(next, titleFor(next))
  }

  const go = (p: string, options: { push?: boolean; select?: string[] | undefined } = {}) =>
    void load(p, { push: options.push ?? true, select: options.select })
  const reload = () => void load(path(), { keep: true })

  const stepHistory = (delta: number) => {
    const i = histIndex() + delta
    const target = history()[i]
    if (target === undefined) return
    setHistIndex(i)
    void load(target, { push: false })
  }

  const columns = (): number => (prefs().view === 'list' ? 1 : geometry().cols)

  const moveSelection = (delta: number, shift: boolean) => {
    const list = rows()
    if (list.length === 0) return
    const current = list.findIndex((x) => x.path === anchor())
    const next =
      current === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(Math.max(0, current + delta), list.length - 1)
    const entry = list[next]
    if (entry === undefined) return
    if (shift && current !== -1) {
      const [from, to] = current < next ? [current, next] : [next, current]
      setSelected(new Set(list.slice(from, to + 1).map((x) => x.path)))
      setAnchor(entry.path)
    } else selectOnly(entry.path)
    reveal(entry.path)
  }

  const handle: PaneHandle = {
    id: props.id,
    go,
    back: () => stepHistory(-1),
    forward: () => stepHistory(1),
    up: () => {
      const parent = path() === TRASH_PATH ? ctx().home() : (listing()?.parent ?? parentOf(path()))
      if (parent !== null) go(parent, { select: [path()] })
    },
    reload,
    path,
    mode,
    listing,
    rows,
    selected: selectedRows,
    select: (paths, a) => {
      setSelected(new Set(paths))
      setAnchor(a ?? paths[0] ?? null)
      const f = paths[0]
      if (f !== undefined) queueMicrotask(() => reveal(f))
    },
    selectAll: () => setSelected(new Set(rows().map((x) => x.path))),
    startRename: (p) => {
      const target = p ?? selectedRows()[0]?.path
      if (target !== undefined && mode() === 'folder') setRenaming(target)
    },
    focus: () => content?.focus(),
    focusFilter: (seed) => {
      setFilterOpen(true)
      queueMicrotask(() => filterInput?.focus())
      if (seed !== undefined) setFilter((f) => f + seed)
    },
    editPath: () => setEditingPath(true),
    clearFilter: () => {
      if (filter() === '') return false
      setFilter('')
      return true
    },
    startSearch: (filters, everywhere) => {
      const root = path() === TRASH_PATH ? ctx().home() : path()
      setSearch({ id: null, root, filters, items: [], done: false, everywhere })
      setSelected(new Set<string>())
      if (everywhere) {
        void api.searchEverywhere(filters.query).then(
          (items) => {
            const s = search()
            if (s?.everywhere !== true) return
            setSearch({ ...s, items, done: true })
          },
          (e: unknown) => {
            ctx().say(errorText(e), 'danger')
            const s = search()
            if (s !== null) setSearch({ ...s, done: true })
          },
        )
      } else {
        void api.searchStart(root, filters).then((id) => {
          const s = search()
          if (s !== null && s.id === null) setSearch({ ...s, id })
        })
      }
      props.onPath(path(), `Search: ${filters.query}`)
    },
    stopSearch: () => {
      if (search() === null) return
      void api.searchStop()
      setSearch(null)
      props.onPath(path(), titleFor(path()))
    },
    isSearching: () => search() !== null,
    moveSelection,
    columns,
    hasFocusInInput: () =>
      renaming() !== null ||
      editingPath() ||
      document.activeElement === filterInput ||
      document.activeElement?.tagName === 'INPUT',
  }

  onMount(() => {
    props.onReady(handle)
    void load(props.initialPath, { push: true, select: props.initialSelect })
    const offChanged = onEvent('fs-changed', (e) => {
      if (e.key === `${windowLabel()}/${props.id}` && e.path === path())
        void load(path(), { keep: true })
    })
    const offSearch = onEvent('search-results', (r) => {
      const s = search()
      if (s === null || r.window !== windowLabel() || (s.id !== null && r.id !== s.id)) return
      if (s.id === null && r.items.length === 0 && !r.done) return
      setSearch({ ...s, id: r.id, items: [...s.items, ...(r.items as Row[])], done: r.done })
    })
    onCleanup(() => {
      offChanged()
      offSearch()
      void api.watch(props.id, null)
      if (search() !== null) void api.searchStop()
    })
  })

  // hidden toggled: reload
  createEffect(
    on(
      () => prefs().hidden,
      () => {
        if (path() !== '' && mode() === 'folder') void load(path(), { keep: true })
      },
      { defer: true },
    ),
  )

  const select = (entry: Row, e: MouseEvent) => {
    const list = rows()
    const start = anchor()
    if (e.shiftKey && start !== null) {
      const a = list.findIndex((x) => x.path === start)
      const b = list.findIndex((x) => x.path === entry.path)
      const [from, to] = a < b ? [a, b] : [b, a]
      const range = list.slice(Math.max(0, from), to + 1).map((x) => x.path)
      setSelected(new Set(e.ctrlKey ? [...selected(), ...range] : range))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected())
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setSelected(next)
      setAnchor(entry.path)
    } else selectOnly(entry.path)
  }

  const crumbs = createMemo(() => {
    const p = path()
    const h = ctx().home()
    if (p === '' || p === TRASH_PATH) return []
    const out: { label: string; path: string }[] = []
    let acc = ''
    let rest = p
    if (h !== '' && (p === h || p.startsWith(`${h}/`))) {
      out.push({ label: 'Home', path: h })
      acc = h
      rest = p.slice(h.length)
    } else out.push({ label: '/', path: '/' })
    for (const part of rest.split('/').filter((x) => x !== '')) {
      acc = `${acc}/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  })

  const syncRoot = createMemo(() => syncRootOf(path(), ctx().places()))
  const syncedFolders = createMemo(
    () =>
      new Map(
        ctx()
          .places()
          .flatMap((p) => (p.sync === undefined ? [] : [[p.path, p.sync] as const])),
      ),
  )

  const status = createMemo(() => {
    const shown = rows()
    const s = search()
    if (s !== null) {
      const n = shown.length
      return `${n} result${n === 1 ? '' : 's'}${s.done ? '' : '…'} for “${s.filters.query}”${s.everywhere ? ' everywhere' : ''}`
    }
    if (listing() === null && path() !== TRASH_PATH) return ''
    const folders = shown.filter((e) => e.dir).length
    const files = shown.length - folders
    const counts = [
      folders > 0 ? `${folders} folder${folders === 1 ? '' : 's'}` : '',
      files > 0 ? `${files} file${files === 1 ? '' : 's'}` : '',
    ]
      .filter((x) => x !== '')
      .join(', ')
    const parts = [counts === '' ? (path() === TRASH_PATH ? 'Trash is empty' : 'Empty') : counts]
    const sel = selectedRows()
    if (sel.length > 0) {
      const bytes = sel.filter((e) => !e.dir).reduce((sum, e) => sum + e.size, 0)
      parts.push(`${sel.length} selected${bytes > 0 ? ` (${formatBytes(bytes)})` : ''}`)
    }
    const free = listing()?.free
    if (free !== null && free !== undefined) parts.push(`${formatBytes(free)} free`)
    return parts.join(' · ')
  })

  const dropHandlers = (dir: () => string) => ({
    'data-drop': dir(),
    onDragOver: (e: DragEvent) => {
      if (dir() === path() && mode() === 'folder' && !e.dataTransfer?.types.includes('Files')) {
        // dropping on the background of the folder we are in: only external files land
        if (!(e.dataTransfer?.types.includes('text/uri-list') ?? false)) return
      }
      e.preventDefault()
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
      ctx().setDropTarget(dir())
    },
    onDragLeave: () => {
      if (ctx().dropTarget() === dir()) ctx().setDropTarget(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ctx().onDomDrop(dir(), e)
    },
  })

  const EntryIcon = (p: { entry: Row; size: number; grid: boolean }): JSX.Element => {
    const kind = () => fileKind(p.entry)
    const [thumb, setThumb] = createSignal<'loading' | 'ok' | 'failed'>('loading')
    const [pdf, setPdf] = createSignal<string | null>(null)
    createEffect(
      on(
        () => p.entry.path,
        () => {
          setThumb('loading')
          setPdf(null)
          if (fileKind(p.entry) === 'pdf' && p.grid)
            void ctx()
              .pdfThumb(p.entry.path)
              .then((url) => {
                if (url !== null) setPdf(url)
              })
        },
      ),
    )
    const wantsThumb = () =>
      (THUMBNAIL_KINDS.has(kind()) || kind() === 'audio') &&
      thumb() !== 'failed' &&
      mode() !== 'trash'
    const sync = () => (p.entry.dir ? syncedFolders().get(p.entry.path) : undefined)
    const exec = () => isExecutable(p.entry) && kind() !== 'package'
    return (
      <span
        class={`fm-icon kind-${kind()}`}
        classList={{
          folder: p.entry.dir,
          exec: exec(),
          'has-thumb': (wantsThumb() && thumb() === 'ok') || pdf() !== null,
          link: p.entry.kind === 'link',
        }}
      >
        <Icon name={exec() && kind() === 'other' ? 'terminal' : KIND_ICON[kind()]} size={p.size} />
        <Show when={sync()}>
          {(state) => (
            <span
              class="fm-icon-sync"
              classList={{ [state().state]: true }}
              title={syncLabel(state())}
            >
              <Icon name={SYNC_ICON[state().state]} size={p.size > 20 ? 14 : 10} />
            </span>
          )}
        </Show>
        <Show when={p.entry.kind === 'link'}>
          <span class="fm-icon-link" title={p.entry.target === 'broken' ? 'Broken link' : 'Link'}>
            <Icon name="link" size={10} />
          </span>
        </Show>
        <Show when={wantsThumb()}>
          <img
            class="fm-thumb"
            src={ctx().thumbUrl(p.entry.path, p.grid ? 256 : 128)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setThumb('ok')}
            onError={() => setThumb('failed')}
          />
        </Show>
        <Show when={pdf()}>
          {(url) => <img class="fm-thumb fm-thumb--pdf" src={url()} alt="" draggable={false} />}
        </Show>
      </span>
    )
  }

  const NameField = (p: { entry: Row }): JSX.Element => (
    <input
      class="fm-rename"
      value={p.entry.name}
      spellcheck={false}
      aria-label="New name"
      ref={(el) =>
        queueMicrotask(() => {
          el.focus()
          const dot = p.entry.dir ? -1 : p.entry.name.lastIndexOf('.')
          el.setSelectionRange(0, dot > 0 ? dot : p.entry.name.length)
        })
      }
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          const v = e.currentTarget.value
          setRenaming(null)
          ctx().commitRename(handle, p.entry, v)
        } else if (e.key === 'Escape') setRenaming(null)
      }}
      onBlur={(e) => {
        if (renaming() !== p.entry.path) return
        const v = e.currentTarget.value
        setRenaming(null)
        ctx().commitRename(handle, p.entry, v)
      }}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
    />
  )

  const itemProps = (entry: () => Row) => ({
    'data-path': entry().path,
    draggable: renaming() !== entry().path && mode() !== 'trash',
    onMouseDown: () => props.onActivate(),
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      select(entry(), e)
    },
    onDblClick: (e: MouseEvent) => {
      e.stopPropagation()
      ctx().open(entry(), handle, e.ctrlKey ? 'tab' : 'default')
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      if (entry().dir) ctx().open(entry(), handle, 'tab')
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      props.onActivate()
      if (!selected().has(entry().path)) selectOnly(entry().path)
      ctx().entryMenu(handle, entry(), { x: e.clientX, y: e.clientY })
    },
    onDragStart: (e: DragEvent) => {
      if (!selected().has(entry().path)) selectOnly(entry().path)
      ctx().startDrag(handle, entry(), e)
    },
  })

  const entryClasses = (entry: Row) => ({
    selected: selected().has(entry.path),
    cut: ctx().cutPaths().has(entry.path),
    hidden: entry.hidden,
    drop: ctx().dropTarget() === entry.path,
  })

  const whereOf = (entry: Row): string => {
    const parent =
      entry.original !== undefined
        ? (parentOf(entry.original) ?? '/')
        : (parentOf(entry.path) ?? '/')
    const h = ctx().home()
    return parent === h
      ? 'Home'
      : parent.startsWith(`${h}/`)
        ? `~${parent.slice(h.length)}`
        : parent
  }

  const listColumns = () => {
    const m = mode()
    if (m === 'trash') return ['name', 'original', 'deleted', 'size'] as const
    if (m === 'search') return ['name', 'where', 'mtime', 'size'] as const
    return ['name', 'mtime', 'size', 'kind'] as const
  }
  const columnLabel = (c: string): string =>
    c === 'original'
      ? 'Original location'
      : c === 'deleted'
        ? 'Deleted'
        : c === 'where'
          ? 'Where'
          : SORT_LABELS[c as SortKey]
  const columnSort = (c: string): SortKey | null =>
    c === 'name' || c === 'mtime' || c === 'size' || c === 'kind'
      ? c
      : c === 'deleted'
        ? 'mtime'
        : null

  return (
    <section
      class="fm-pane"
      classList={{ active: props.active, searching: search() !== null, [tier()]: true }}
      ref={(el) => {
        const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth))
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      }}
      onMouseDown={() => props.onActivate()}
    >
      <header class="fm-toolbar">
        <IconButton
          icon="arrow-left"
          label="Back"
          disabled={histIndex() <= 0}
          onClick={() => stepHistory(-1)}
        />
        <Show when={tier() !== 'narrow'}>
          <IconButton
            icon="arrow-right"
            label="Forward"
            disabled={histIndex() >= history().length - 1}
            onClick={() => stepHistory(1)}
          />
        </Show>
        <IconButton
          icon="arrow-up"
          label="Up (Alt+Up)"
          disabled={path() === '/'}
          onClick={() => handle.up()}
        />
        <div
          class="fm-crumbs"
          classList={{
            editing: editingPath(),
            hidden: tier() !== 'wide' && filterShown() && !editingPath(),
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingPath(true)
          }}
        >
          <Show
            when={editingPath()}
            fallback={
              <Show
                when={mode() !== 'trash'}
                fallback={
                  <span class="fm-crumb last">
                    <Icon name="trash-2" size={14} />
                    Trash
                  </span>
                }
              >
                <Show when={tier() === 'narrow' && crumbs().length > 1}>
                  <button
                    class="fm-crumb"
                    aria-label="Parent folders"
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = e.currentTarget.getBoundingClientRect()
                      const parents = crumbs().slice(0, -1).reverse()
                      ctx().menu(
                        parents.map((c) => ({
                          type: 'item' as const,
                          id: c.path,
                          label: c.label,
                          icon: c.label === 'Home' ? ('house' as const) : ('folder' as const),
                          run: () => go(c.path),
                        })),
                        { x: r.left, y: r.bottom + 4 },
                      )
                    }}
                  >
                    …
                  </button>
                  <Icon name="chevron-right" size={12} class="fm-crumb-sep" />
                </Show>
                <Index each={tier() === 'narrow' ? crumbs().slice(-1) : crumbs()}>
                  {(crumb, i) => (
                    <>
                      <Show when={i > 0 && tier() !== 'narrow'}>
                        <Icon name="chevron-right" size={12} class="fm-crumb-sep" />
                      </Show>
                      <button
                        class="fm-crumb"
                        classList={{
                          last: i === crumbs().length - 1,
                          drop: ctx().dropTarget() === crumb().path,
                        }}
                        onClick={() => go(crumb().path)}
                        onAuxClick={(e) => {
                          if (e.button !== 1) return
                          e.preventDefault()
                          ctx().open(
                            { ...emptyRow(crumb().path), dir: true, kind: 'dir' },
                            handle,
                            'tab',
                          )
                        }}
                        {...dropHandlers(() => crumb().path)}
                      >
                        <Show when={crumb().label === 'Home' && i === 0 && tier() !== 'narrow'}>
                          <Icon name="house" size={14} />
                        </Show>
                        {crumb().label}
                      </button>
                    </>
                  )}
                </Index>
              </Show>
            }
          >
            <input
              class="fm-path-input"
              value={path() === TRASH_PATH ? '' : path()}
              spellcheck={false}
              aria-label="Location"
              ref={(el) =>
                queueMicrotask(() => {
                  el.focus()
                  el.select()
                })
              }
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const value = e.currentTarget.value.trim()
                  setEditingPath(false)
                  go(value === '' ? '~' : value)
                } else if (e.key === 'Escape') setEditingPath(false)
              }}
              onBlur={() => setEditingPath(false)}
            />
          </Show>
        </div>
        <Show when={syncRoot()}>
          {(root) => (
            <Show when={root().sync}>
              {(sync) => (
                <button
                  class="fm-sync-chip"
                  classList={{ [sync().state]: true }}
                  title={`${syncTitle(root().path, sync())} · Sync settings in ewe Sync`}
                  onClick={() => ctx().openSyncSettings()}
                >
                  <Icon name={SYNC_ICON[sync().state]} size={14} />
                  <span>{syncLabel(sync())}</span>
                </button>
              )}
            </Show>
          )}
        </Show>
        <Show when={!filterShown()}>
          <IconButton
            icon="search"
            label="Filter (Ctrl+F)"
            onClick={() => {
              setFilterOpen(true)
              queueMicrotask(() => filterInput?.focus())
            }}
          />
        </Show>
        <label
          class="fm-filter"
          classList={{ on: filter() !== '', wide: tier() !== 'wide', hidden: !filterShown() }}
        >
          <Icon name="search" size={14} />
          <input
            ref={filterInput}
            value={filter()}
            placeholder={mode() === 'search' ? 'Narrow down' : 'Filter'}
            spellcheck={false}
            aria-label="Filter this folder"
            onInput={(e) => setFilter(e.currentTarget.value)}
            onBlur={() => {
              if (filter() === '') setFilterOpen(false)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setFilter('')
                setFilterOpen(false)
                content?.focus()
              } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault()
                content?.focus()
                const first = rows()[0]
                if (first === undefined) return
                selectOnly(first.path)
                if (e.key === 'Enter') ctx().open(first, handle, 'default')
              }
            }}
          />
        </label>
        <Show when={tier() !== 'narrow'}>
          <IconButton
            icon="folder-plus"
            label="New folder (Ctrl+Shift+N)"
            disabled={!(listing()?.writable ?? false) || mode() !== 'folder'}
            onClick={() => ctx().newFolder(handle)}
          />
        </Show>
        <Show when={tier() === 'wide'}>
          <IconButton
            icon={prefs().hidden ? 'eye' : 'eye-off'}
            label={prefs().hidden ? 'Hide hidden files (Ctrl+H)' : 'Show hidden files (Ctrl+H)'}
            active={prefs().hidden}
            onClick={() => ctx().setPref(path(), { hidden: !prefs().hidden })}
          />
          <IconButton
            icon="arrow-up-down"
            label={`Sort by ${SORT_LABELS[prefs().sort].toLowerCase()}`}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              ctx().sortMenu(handle, { x: r.left, y: r.bottom + 4 })
            }}
          />
          <div class="fm-views" role="radiogroup" aria-label="View">
            <button
              class="fm-view"
              classList={{ on: prefs().view === 'grid' }}
              role="radio"
              aria-checked={prefs().view === 'grid'}
              title="Grid (Ctrl+1)"
              onClick={() => ctx().setPref(path(), { view: 'grid' })}
            >
              <Icon name="layout-grid" size={14} />
            </button>
            <button
              class="fm-view"
              classList={{ on: prefs().view === 'list' }}
              role="radio"
              aria-checked={prefs().view === 'list'}
              title="List (Ctrl+2)"
              onClick={() => ctx().setPref(path(), { view: 'list' })}
            >
              <Icon name="list" size={14} />
            </button>
          </div>
        </Show>
        <Show when={tier() !== 'wide'}>
          <IconButton
            icon="ellipsis"
            label="More"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const p = prefs()
              const items: MenuEntry[] = []
              if (tier() === 'narrow')
                items.push({
                  type: 'item',
                  id: 'new-folder',
                  label: 'New folder',
                  icon: 'folder-plus',
                  hint: 'Ctrl+Shift+N',
                  disabled: !(listing()?.writable ?? false) || mode() !== 'folder',
                  run: () => ctx().newFolder(handle),
                })
              items.push(
                {
                  type: 'item',
                  id: 'view-grid',
                  label: 'Grid',
                  icon: p.view === 'grid' ? 'check' : 'layout-grid',
                  hint: 'Ctrl+1',
                  run: () => ctx().setPref(path(), { view: 'grid' }),
                },
                {
                  type: 'item',
                  id: 'view-list',
                  label: 'List',
                  icon: p.view === 'list' ? 'check' : 'list',
                  hint: 'Ctrl+2',
                  run: () => ctx().setPref(path(), { view: 'list' }),
                },
                { type: 'separator' },
                ...SORT_KEYS.map((k): MenuEntry => ({
                  type: 'item',
                  id: `sort-${k}`,
                  label: `Sort by ${SORT_LABELS[k].toLowerCase()}`,
                  icon: p.sort === k ? 'check' : undefined,
                  run: () => ctx().setPref(path(), { sort: k }),
                })),
                {
                  type: 'item',
                  id: 'desc',
                  label: 'Descending',
                  icon: p.desc ? 'check' : undefined,
                  run: () => ctx().setPref(path(), { desc: !p.desc }),
                },
                { type: 'separator' },
                {
                  type: 'item',
                  id: 'hidden',
                  label: p.hidden ? 'Hide hidden files' : 'Show hidden files',
                  icon: p.hidden ? 'eye-off' : 'eye',
                  hint: 'Ctrl+H',
                  run: () => ctx().setPref(path(), { hidden: !p.hidden }),
                },
              )
              ctx().menu(items, { x: r.right, y: r.bottom + 4 })
            }}
          />
        </Show>
      </header>

      <Show when={search()}>
        {(s) => (
          <div class="fm-searchbar">
            <Icon
              name={s().done ? 'search' : 'refresh-cw'}
              size={14}
              class={s().done ? '' : 'spin'}
            />
            <span class="fm-searchbar-text">
              {s().everywhere ? 'Everywhere' : `In ${titleFor(s().root)} and its folders`}: “
              {s().filters.query}”{s().filters.kind !== '' ? ` · ${s().filters.kind}` : ''}
              {s().filters.days > 0 ? ` · last ${s().filters.days} days` : ''}
            </span>
            <button class="btn btn--ghost btn--sm" onClick={() => handle.stopSearch()}>
              Back to the folder
            </button>
          </div>
        )}
      </Show>

      <div
        class="fm-content"
        classList={{ grid: prefs().view === 'grid', list: prefs().view === 'list' }}
        style={{ '--fm-tile': `${prefs().zoom}px` }}
        ref={(el) => {
          content = el
          const ro = new ResizeObserver(() =>
            setViewport({ width: el.clientWidth, height: el.clientHeight }),
          )
          ro.observe(el)
          onCleanup(() => ro.disconnect())
        }}
        tabindex="0"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onClick={() => setSelected(new Set<string>())}
        onContextMenu={(e) => {
          e.preventDefault()
          setSelected(new Set<string>())
          ctx().backgroundMenu(handle, { x: e.clientX, y: e.clientY })
        }}
        {...(mode() === 'folder' ? dropHandlers(() => path()) : {})}
      >
        <Show when={error()}>
          {(message) => (
            <div class="fm-empty">
              <Icon name="circle-alert" size={32} />
              <span class="fm-empty-title">{message()}</span>
              <span class="fm-empty-desc">{path()}</span>
              <button class="btn btn--secondary btn--sm" onClick={() => go('~')}>
                Go home
              </button>
            </div>
          )}
        </Show>
        <Show when={error() === null && !loading() && rows().length === 0}>
          <div class="fm-empty">
            <Icon
              name={
                filter() !== ''
                  ? 'search'
                  : mode() === 'trash'
                    ? 'trash-2'
                    : mode() === 'search'
                      ? 'search'
                      : 'folder-open'
              }
              size={32}
            />
            <span class="fm-empty-title">
              {filter() !== ''
                ? `Nothing matches “${filter()}”`
                : mode() === 'trash'
                  ? 'Trash is empty'
                  : mode() === 'search'
                    ? search()?.done === true
                      ? 'Nothing found'
                      : 'Searching…'
                    : 'This folder is empty'}
            </span>
          </div>
        </Show>
        <Show when={prefs().view === 'list' && rows().length > 0}>
          <div class="fm-head" classList={{ [`cols-${mode()}`]: true }}>
            <For each={[...listColumns()]}>
              {(key) => (
                <button
                  class={`fm-col fm-col-${key}`}
                  classList={{ on: columnSort(key) === prefs().sort }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const k = columnSort(key)
                    if (k === null) return
                    if (prefs().sort === k) ctx().setPref(path(), { desc: !prefs().desc })
                    else ctx().setPref(path(), { sort: k, desc: false })
                  }}
                >
                  {columnLabel(key)}
                  <Show when={columnSort(key) === prefs().sort}>
                    <Icon name={prefs().desc ? 'chevron-down' : 'arrow-up'} size={12} />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="fm-spacer" style={{ height: `${window_().before}px` }} />
        <Index each={shown()}>
          {(entry) => (
            <Show
              when={prefs().view === 'grid'}
              fallback={
                <div
                  class="fm-row"
                  classList={{ ...entryClasses(entry()), [`cols-${mode()}`]: true }}
                  {...itemProps(entry)}
                  {...(entry().dir && mode() === 'folder' ? dropHandlers(() => entry().path) : {})}
                >
                  <span class="fm-col fm-col-name">
                    <EntryIcon entry={entry()} size={16} grid={false} />
                    <Show
                      when={renaming() === entry().path}
                      fallback={<span class="fm-name">{entry().name}</span>}
                    >
                      <NameField entry={entry()} />
                    </Show>
                  </span>
                  <Show when={mode() === 'folder'}>
                    <span class="fm-col fm-col-mtime">{formatDate(entry().mtime)}</span>
                    <span class="fm-col fm-col-size">
                      {entry().dir ? '' : formatBytes(entry().size)}
                    </span>
                    <span class="fm-col fm-col-kind">{KIND_LABEL[fileKind(entry())]}</span>
                  </Show>
                  <Show when={mode() === 'trash'}>
                    <span class="fm-col fm-col-where" title={entry().original}>
                      {whereOf(entry())}
                    </span>
                    <span class="fm-col fm-col-mtime">{formatDate(entry().deleted ?? 0)}</span>
                    <span class="fm-col fm-col-size">
                      {entry().dir ? '' : formatBytes(entry().size)}
                    </span>
                  </Show>
                  <Show when={mode() === 'search'}>
                    <span class="fm-col fm-col-where" title={entry().path}>
                      {whereOf(entry())}
                    </span>
                    <span class="fm-col fm-col-mtime">{formatDate(entry().mtime)}</span>
                    <span class="fm-col fm-col-size">
                      {entry().dir ? '' : formatBytes(entry().size)}
                    </span>
                  </Show>
                </div>
              }
            >
              <div
                class="fm-tile"
                classList={entryClasses(entry())}
                title={
                  mode() === 'folder'
                    ? entry().name
                    : `${entry().name}\n${entry().original ?? entry().path}`
                }
                {...itemProps(entry)}
                {...(entry().dir && mode() === 'folder' ? dropHandlers(() => entry().path) : {})}
              >
                <EntryIcon entry={entry()} size={36} grid />
                <Show
                  when={renaming() === entry().path}
                  fallback={<span class="fm-name">{entry().name}</span>}
                >
                  <NameField entry={entry()} />
                </Show>
                <Show when={mode() !== 'folder'}>
                  <span class="fm-sub">{whereOf(entry())}</span>
                </Show>
              </div>
            </Show>
          )}
        </Index>
        <div class="fm-spacer" style={{ height: `${window_().after}px` }} />
      </div>

      <footer class="fm-status">
        <span class="fm-status-text">{status()}</span>
        <Show when={loading() || (search() !== null && search()?.done !== true)}>
          <span class="fm-spinner" aria-label="Working" />
        </Show>
      </footer>
    </section>
  )
}

export function emptyRow(path: string): Row {
  return {
    name: baseName(path),
    path,
    kind: 'file',
    dir: false,
    size: 0,
    mtime: 0,
    hidden: false,
    target: null,
    mode: 0,
  }
}

export type { FsPlaceSync }
