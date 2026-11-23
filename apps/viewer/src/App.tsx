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
import { comboKey, type AppInfo, type Launch, type MediaServer, type MimeInfo } from '@ewe/shared'
import {
  Dialog,
  Icon,
  IconButton,
  Menu,
  OpenWith,
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
  // the file a tab shows NOW: the picture view steps through its folder, and the
  // menus, "Show in folder" and "open it again" must mean that picture
  const [paths, setPaths] = createSignal<Record<string, string>>({})
  const pathOf = (tab: DocTab): string => paths()[tab.id] ?? tab.path
  const [selected, setSelected] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [tabMenu, setTabMenu] = createSignal<{ id: string; at: { x: number; y: number } } | null>(
    null,
  )
  const [about, setAbout] = createSignal<string | null>(null)
  const [dropping, setDropping] = createSignal(false)
  const [startRefresh, setStartRefresh] = createSignal(0)
  const [openWith, setOpenWith] = createSignal<{
    path: string
    type: MimeInfo | null
    apps: AppInfo[]
    all?: AppInfo[]
  } | null>(null)

  const current = () => tabs().find((t) => t.id === selected()) ?? null

  const openPaths = (paths: string[], opts: { select?: boolean; flags?: string[] } = {}) => {
    const fresh: DocTab[] = []
    let firstExisting: string | null = null
    for (const path of paths) {
      const existing = tabs().find((t) => pathOf(t) === path)
      if (existing !== undefined) {
        firstExisting ??= existing.id
        continue
      }
      const tab: DocTab = {
        id: `t${nextTab++}`,
        path,
        kind: docKind(path),
        title: baseName(path),
        flags: opts.flags ?? [],
      }
      fresh.push(tab)
      // The tab opens at once and the file is checked behind it: waiting for the
      // answer first kept every picture and document ~50 ms from the screen, for
      // the rare path that is not there (a recent file that was since deleted).
      void fileStat(path)
        .catch(() => null)
        .then((stat) => {
          if (stat?.exists === true) return
          toast(`${baseName(path)} is not there`, { kind: 'warning' })
          closeTab(tab.id)
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
    void getCurrentWindow().setTitle(titleFor(current()))
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
      ...(cur === null ? {} : { defaultPath: pathOf(cur).slice(0, pathOf(cur).lastIndexOf('/')) }),
    })
    if (picked === null) return
    openPaths(Array.isArray(picked) ? picked : [picked])
  }

  const showOpenWith = async () => {
    const tab = current()
    if (tab === null) return
    const path = pathOf(tab)
    const mime = await invoke<MimeInfo>('mime_of', { path }).catch(() => null)
    const apps =
      mime === null
        ? []
        : await invoke<AppInfo[]>('apps_for', { contentType: mime.type, all: false }).catch(
            (): AppInfo[] => [],
          )
    setOpenWith({ path, type: mime, apps })
  }

  const showAllApps = () => {
    void invoke<AppInfo[]>('apps_for', { contentType: '', all: true })
      .catch((): AppInfo[] => [])
      .then((all) => setOpenWith((o) => (o === null ? null : { ...o, all })))
  }

  const launchWith = async (app: AppInfo, always: boolean) => {
    const target = openWith()
    if (target === null) return
    try {
      if (always && target.type !== null)
        await invoke<null>('set_default_app', { desktopId: app.id, contentType: target.type.type })
      await invoke<null>('launch_with', { desktopId: app.id, paths: [target.path] })
      setOpenWith(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'danger' })
    }
  }

  const showInFiles = async () => {
    const tab = current()
    if (tab === null) return
    const path = pathOf(tab)
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
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
      openPaths(launch.paths, { flags: launch.flags })
      // `--open-with`: the Open with card for the first file (scripts/shot.sh)
      if (launch.flags.includes('--open-with')) setTimeout(() => void showOpenWith(), 600)
    })()
    onCleanup(
      onLaunch((next: Launch) => {
        openPaths(next.paths, { flags: next.flags })
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
          openPaths(event.payload.paths)
        }
      })
      .then((off) => {
        unlistenDrop = off
      })
    onCleanup(() => unlistenDrop?.())

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (isMod(e)) {
        // the letter on the key, whatever the layout types (Ctrl+O on a Georgian one)
        const k = comboKey(e).toLowerCase()
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
          void navigator.clipboard.writeText(pathOf(t)).then(() => toast('Path copied'))
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
            hint: pathOf(t),
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
                    onOpen={(p) => openPaths([p])}
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
                    onOpen: (p: string) => openPaths([p]),
                    onTitle: (title: string) => {
                      // a separate map: replacing the tab object would remount the view
                      setTitles((m) => ({ ...m, [tab.id]: title }))
                      if (active()) void getCurrentWindow().setTitle(titleFor(current()))
                    },
                    onPath: (path: string) => {
                      if (pathOf(tab) !== path) setPaths((m) => ({ ...m, [tab.id]: path }))
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
      <OpenWith
        open={openWith() !== null}
        subject={baseName(openWith()?.path ?? '')}
        typeLabel={openWith()?.type?.description}
        apps={openWith()?.apps}
        allApps={openWith()?.all}
        server={server()}
        onShowAll={showAllApps}
        onOpen={(app, always) => void launchWith(app, always)}
        onClose={() => setOpenWith(null)}
      />
      <Toasts />
    </div>
  )
}
