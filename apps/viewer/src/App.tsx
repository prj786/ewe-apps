import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { AppInfo, Launch, MediaServer, MimeInfo } from '@ewe/shared'
import {
  Dialog,
  Icon,
  IconButton,
  Menu,
  Tabs,
  Toasts,
  Toolbar,
  applyShotSize,
  getAppVersion,
  getLaunch,
  getMediaServer,
  onLaunch,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import { fileStat } from './lib/bridge'
import { isMod } from './lib/keys'
import { KIND_ICON, OPEN_FILTERS, baseName, docKind, type DocKind } from './lib/kinds'
import { flush } from './lib/store'
import { ComicView } from './views/ComicView'
import { DocxView } from './views/DocxView'
import { EpubView } from './views/EpubView'
import { ImageView } from './views/ImageView'
import { OtherView } from './views/OtherView'
import { PdfView } from './views/PdfView'
import { SheetView } from './views/SheetView'
import { Start } from './views/Start'
import { TextView } from './views/TextView'

interface DocTab {
  id: string
  path: string
  kind: DocKind
  title: string
  /** the launch flags that came with this path (`--page=3`, `--find=…`) */
  flags: string[]
}

let nextTab = 1

export function App(): JSX.Element {
  const [server, setServer] = createSignal<MediaServer | null>(null)
  const [tabs, setTabs] = createSignal<DocTab[]>([])
  const [titles, setTitles] = createSignal<Record<string, string>>({})
  const [selected, setSelected] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [tabMenu, setTabMenu] = createSignal<{ id: string; at: { x: number; y: number } } | null>(
    null,
  )
  const [about, setAbout] = createSignal<string | null>(null)
  const [dropping, setDropping] = createSignal(false)
  const [startRefresh, setStartRefresh] = createSignal(0)
  const [openWith, setOpenWith] = createSignal<{ path: string; apps: AppInfo[] } | null>(null)

  const current = () => tabs().find((t) => t.id === selected()) ?? null

  const openPaths = async (paths: string[], opts: { select?: boolean; flags?: string[] } = {}) => {
    const fresh: DocTab[] = []
    let firstExisting: string | null = null
    for (const path of paths) {
      const existing = tabs().find((t) => t.path === path)
      if (existing !== undefined) {
        firstExisting ??= existing.id
        continue
      }
      const stat = await fileStat(path).catch(() => null)
      if (!stat?.exists) {
        toast(`${baseName(path)} is not there`, { kind: 'warning' })
        continue
      }
      fresh.push({
        id: `t${nextTab++}`,
        path,
        kind: docKind(path),
        title: baseName(path),
        flags: opts.flags ?? [],
      })
    }
    batch(() => {
      if (fresh.length > 0) setTabs((list) => [...list, ...fresh])
      const target = fresh[0]?.id ?? firstExisting
      if (target !== null && target !== undefined && (opts.select ?? true)) setSelected(target)
    })
    void getCurrentWindow().setTitle(titleFor(current()))
  }

  const titleFor = (tab: DocTab | null) =>
    tab === null ? 'ewe Viewer' : `${titles()[tab.id] ?? tab.title} — ewe Viewer`

  const closeTab = (id: string) => {
    const list = tabs()
    const i = list.findIndex((t) => t.id === id)
    if (i === -1) return
    const rest = list.filter((t) => t.id !== id)
    batch(() => {
      setTabs(rest)
      if (selected() === id) setSelected(rest[Math.min(i, rest.length - 1)]?.id ?? null)
    })
    flush()
    setStartRefresh((n) => n + 1)
    void getCurrentWindow().setTitle(titleFor(current()))
  }

  const closeOthers = (id: string) => {
    setTabs((list) => list.filter((t) => t.id === id))
    setSelected(id)
  }

  const select = (id: string) => {
    setSelected(id)
    void getCurrentWindow().setTitle(titleFor(current()))
  }

  const cycle = (delta: number) => {
    const list = tabs()
    if (list.length < 2) return
    const i = list.findIndex((t) => t.id === selected())
    const next = list[(i + delta + list.length) % list.length]
    if (next !== undefined) select(next.id)
  }

  const browse = async () => {
    const cur = current()
    const picked = await open({
      multiple: true,
      directory: false,
      title: 'Open',
      filters: OPEN_FILTERS,
      ...(cur === null ? {} : { defaultPath: cur.path.slice(0, cur.path.lastIndexOf('/')) }),
    })
    if (picked === null) return
    await openPaths(Array.isArray(picked) ? picked : [picked])
  }

  const showOpenWith = async () => {
    const tab = current()
    if (tab === null) return
    const mime = await invoke<MimeInfo>('mime_of', { path: tab.path }).catch(() => null)
    const apps =
      mime === null
        ? []
        : await invoke<AppInfo[]>('apps_for', { contentType: mime.type, all: false }).catch(
            (): AppInfo[] => [],
          )
    setOpenWith({ path: tab.path, apps })
  }

  const launchWith = async (app: AppInfo | null) => {
    const target = openWith()
    if (target === null) return
    try {
      await invoke<null>('launch_with', { desktopId: app?.id ?? null, paths: [target.path] })
      setOpenWith(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'danger' })
    }
  }

  const showInFiles = async () => {
    const tab = current()
    if (tab === null) return
    const dir = tab.path.slice(0, tab.path.lastIndexOf('/')) || '/'
    try {
      await invoke<null>('launch_with', { desktopId: null, paths: [dir] })
    } catch {
      toast('No file manager answered', { kind: 'warning' })
    }
  }

  onMount(() => {
    void (async () => {
      const [media, launch] = await Promise.all([getMediaServer(), getLaunch()])
      applyShotSize(launch.flags)
      setServer(media)
      await openPaths(launch.paths, { flags: launch.flags })
    })()
    onCleanup(
      onLaunch((next: Launch) => {
        void openPaths(next.paths, { flags: next.flags })
      }),
    )
    void getAppVersion().then((v) => setAbout((a) => (a === null ? null : v.version)))

    let unlistenDrop: (() => void) | null = null
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') setDropping(true)
        else if (event.payload.type === 'leave') setDropping(false)
        else if (event.payload.type === 'drop') {
          setDropping(false)
          void openPaths(event.payload.paths)
        }
      })
      .then((off) => {
        unlistenDrop = off
      })
    onCleanup(() => unlistenDrop?.())

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (isMod(e)) {
        const k = e.key.toLowerCase()
        if (k === 'o' || (k === 't' && !e.shiftKey)) {
          e.preventDefault()
          void browse()
        } else if (k === 'w') {
          e.preventDefault()
          const id = selected()
          if (id !== null) closeTab(id)
          else void getCurrentWindow().close()
        } else if (k === 'q') {
          e.preventDefault()
          flush()
          void getCurrentWindow().close()
        } else if (e.key === 'Tab' || k === 'pagedown' || k === 'pageup') {
          e.preventDefault()
          cycle(e.shiftKey || k === 'pageup' ? -1 : 1)
        } else if (/^[1-9]$/.test(e.key) && !e.altKey && !e.shiftKey && tabs().length > 1) {
          const list = tabs()
          const target = e.key === '9' ? list[list.length - 1] : list[Number(e.key) - 1]
          if (target !== undefined) {
            e.preventDefault()
            select(target.id)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const menuItems = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'open',
      label: 'Open…',
      icon: 'folder-open',
      hint: 'Ctrl+O',
      run: () => void browse(),
    },
    {
      type: 'item',
      id: 'open-with',
      label: 'Open with…',
      icon: 'external-link',
      disabled: current() === null,
      run: () => void showOpenWith(),
    },
    {
      type: 'item',
      id: 'show',
      label: 'Show in folder',
      icon: 'folder',
      disabled: current() === null,
      run: () => void showInFiles(),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'close',
      label: 'Close tab',
      icon: 'x',
      hint: 'Ctrl+W',
      disabled: current() === null,
      run: () => {
        const id = selected()
        if (id !== null) closeTab(id)
      },
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'about',
      label: 'About ewe Viewer',
      icon: 'info',
      run: () => void getAppVersion().then((v) => setAbout(v.version)),
    },
  ]

  const tabMenuItems = (id: string): MenuEntry[] => [
    { type: 'item', id: 'close', label: 'Close', icon: 'x', run: () => closeTab(id) },
    {
      type: 'item',
      id: 'others',
      label: 'Close other tabs',
      disabled: tabs().length < 2,
      run: () => closeOthers(id),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'copy',
      label: 'Copy path',
      icon: 'copy',
      run: () => {
        const t = tabs().find((x) => x.id === id)
        if (t !== undefined)
          void navigator.clipboard.writeText(t.path).then(() => toast('Path copied'))
      },
    },
  ]

  return (
    <div class="app" classList={{ 'app--dropping': dropping() }}>
      <header class="app-header">
        <h1 class="app-name">
          <Icon name="book-open" />
          <span class="app-name-text">ewe Viewer</span>
        </h1>
        <Tabs
          class="app-tabs"
          tabs={tabs().map((t) => ({
            id: t.id,
            label: titles()[t.id] ?? t.title,
            icon: KIND_ICON[t.kind],
            hint: t.path,
          }))}
          selected={selected() ?? ''}
          label="Open documents"
          onSelect={select}
          onClose={closeTab}
          onAdd={() => void browse()}
          onMenu={(id, at) => setTabMenu({ id, at })}
        />
        <Toolbar label="Window" class="toolbar--header">
          <span class="toolbar-spacer" />
          <IconButton
            icon="ellipsis"
            label="Menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenuAt({ x: r.right, y: r.bottom + 4 })
            }}
          />
        </Toolbar>
      </header>
      <main class="app-body">
        <Show when={server()}>
          {(media) => (
            <>
              <Show when={current() === null}>
                <div class="page">
                  <Start
                    server={media()}
                    refresh={startRefresh()}
                    onOpen={(p) => void openPaths([p])}
                    onBrowse={() => void browse()}
                  />
                </div>
              </Show>
              <For each={tabs()}>
                {(tab) => {
                  const active = () => tab.id === selected()
                  const viewProps = () => ({
                    path: tab.path,
                    server: media(),
                    active: active(),
                    onOpen: (p: string) => void openPaths([p]),
                    onTitle: (title: string) => {
                      // a separate map: replacing the tab object would remount the view
                      setTitles((m) => ({ ...m, [tab.id]: title }))
                      if (active()) void getCurrentWindow().setTitle(titleFor(current()))
                    },
                    onClose: () => closeTab(tab.id),
                    flags: tab.flags,
                  })
                  return (
                    <div
                      class="page doc"
                      classList={{ 'doc--hidden': !active() }}
                      role="tabpanel"
                      aria-hidden={!active()}
                    >
                      <Switch fallback={<OtherView {...viewProps()} />}>
                        <Match when={tab.kind === 'pdf'}>
                          <PdfView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'epub'}>
                          <EpubView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'comic'}>
                          <ComicView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'markdown' || tab.kind === 'text'}>
                          <TextView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'docx'}>
                          <DocxView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'sheet' || tab.kind === 'csv'}>
                          <SheetView {...viewProps()} />
                        </Match>
                        <Match when={tab.kind === 'image'}>
                          <ImageView {...viewProps()} />
                        </Match>
                      </Switch>
                    </div>
                  )
                }}
              </For>
            </>
          )}
        </Show>
        <Show when={dropping()}>
          <div class="drop-hint" aria-hidden="true">
            <Icon name="import" size={32} />
            <span>Drop to open</span>
          </div>
        </Show>
      </main>
      <Show when={menuAt()}>
        {(at) => <Menu items={menuItems()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
      <Show when={tabMenu()}>
        {(m) => <Menu items={tabMenuItems(m().id)} at={m().at} onClose={() => setTabMenu(null)} />}
      </Show>
      <Dialog
        open={about() !== null}
        title="ewe Viewer"
        description={`Version ${about() ?? ''} · the document and picture viewer of the ewe desktop.`}
        onClose={() => setAbout(null)}
      >
        <dl class="info-rows">
          <dt>PDF</dt>
          <dd>pdf.js (Apache-2.0)</dd>
          <dt>Books</dt>
          <dd>foliate-js (MIT)</dd>
          <dt>Word</dt>
          <dd>docx-preview (Apache-2.0)</dd>
          <dt>Spreadsheets</dt>
          <dd>SheetJS Community Edition (Apache-2.0)</dd>
          <dt>Code</dt>
          <dd>highlight.js (BSD-3), marked (MIT), DOMPurify (Apache-2.0)</dd>
        </dl>
      </Dialog>
      <Dialog
        open={openWith() !== null}
        title="Open with"
        description={baseName(openWith()?.path ?? '')}
        onClose={() => setOpenWith(null)}
      >
        <Show
          when={(openWith()?.apps ?? []).length > 0}
          fallback={<p class="dialog-desc">No other app on this machine opens this type.</p>}
        >
          <ul class="app-list">
            <For each={openWith()?.apps ?? []}>
              {(app) => (
                <li>
                  <button type="button" class="app-list-row" onClick={() => void launchWith(app)}>
                    <Icon name="external-link" />
                    <span class="app-list-name">{app.name}</span>
                    <Show when={app.default}>
                      <span class="app-list-hint">Default</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Dialog>
      <Toasts />
    </div>
  )
}
