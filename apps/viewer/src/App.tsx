import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import type { Launch } from '@ewe/shared'
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Menu,
  ProgressBar,
  Segmented,
  Slider,
  Switch,
  Tabs,
  Toasts,
  Toolbar,
  getLaunch,
  onLaunch,
  toast,
  type MenuEntry,
} from '@ewe/ui'

export function App(): JSX.Element {
  const [launch, setLaunch] = createSignal<Launch | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [remember, setRemember] = createSignal(true)
  const [demo, setDemo] = createSignal(false)
  const [view, setView] = createSignal('grid')
  const [volume, setVolume] = createSignal(64)
  const [query, setQuery] = createSignal('')
  const [tab, setTab] = createSignal('a')

  onMount(() => {
    void getLaunch().then((l) => {
      setLaunch(l)
      // `--demo`: show the whole kit at once (screenshots, a visual check of the theme)
      if (l.flags.includes('--demo')) {
        setDemo(true)
        setMenuAt({ x: 24, y: 48 })
        toast('The kit is up', { kind: 'success' })
      }
    })
    onCleanup(
      onLaunch((next) => {
        setLaunch(next)
        toast(next.paths.length === 0 ? 'Opened again' : `Opened ${next.paths.length} more`)
      }),
    )
  })

  const items: MenuEntry[] = [
    {
      type: 'item',
      id: 'open',
      label: 'Open…',
      icon: 'folder-open',
      hint: 'Ctrl+O',
      run: () => toast('Open is on its way'),
    },
    {
      type: 'item',
      id: 'recent',
      label: 'Recent',
      icon: 'history',
      items: [{ type: 'item', id: 'none', label: 'Nothing yet', disabled: true }],
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'about',
      label: 'About ewe Viewer',
      icon: 'info',
      run: () => toast('ewe Viewer 0.1.0-beta'),
    },
  ]

  return (
    <div class="app">
      <header class="app-header">
        <h1 class="app-name">
          <Icon name="file-text" />
          ewe Viewer
        </h1>
        <Toolbar label="Window" class="toolbar--header">
          <span class="toolbar-spacer" />
          <IconButton
            icon="ellipsis"
            label="Menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenuAt({ x: r.left, y: r.bottom + 4 })
            }}
          />
        </Toolbar>
      </header>
      <main class="app-body">
        <div class="page centered">
          <EmptyState icon="book-open" title="Your documents will be here" heading="h2">
            PDFs, books, pictures, text and spreadsheets open in tabs. ewe Viewer is being built.
          </EmptyState>
          <div class="demo-row">
            <Switch checked={remember()} label="Remember where I left off" onChange={setRemember} />
            <span>Remember where I left off</span>
          </div>
          <Show when={launch()}>
            {(l) => (
              <Show when={l().paths.length > 0}>
                <div class="demo-paths" aria-label="Opened paths">
                  <For each={l().paths}>{(p) => <span>{p}</span>}</For>
                </div>
              </Show>
            )}
          </Show>
        </div>
      </main>
      <Show when={menuAt()}>
        {(at) => <Menu items={items} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
      <Dialog
        open={demo()}
        title="The shared kit"
        description="Every control the apps share, in the live theme."
        onClose={() => setDemo(false)}
        actions={
          <>
            <Button kind="ghost" onClick={() => setDemo(false)}>
              Cancel
            </Button>
            <Button kind="primary" onClick={() => setDemo(false)}>
              Looks right
            </Button>
          </>
        }
      >
        <div class="demo-stack">
          <Tabs
            tabs={[
              { id: 'a', label: 'Documents', icon: 'file-text' },
              { id: 'b', label: 'Pictures', icon: 'image', dot: true },
              { id: 'c', label: 'Notes.md', icon: 'file-code' },
            ]}
            selected={tab()}
            label="Open items"
            onSelect={setTab}
            onClose={() => toast('Closed a tab')}
            onAdd={() => toast('New tab')}
          />
          <Field
            value={query()}
            label="Filter"
            placeholder="Filter…"
            icon="search"
            clearable
            onInput={setQuery}
          />
          <div class="demo-row">
            <Segmented
              value={view()}
              label="View"
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'list', label: 'List' },
              ]}
              onChange={setView}
            />
            <Switch checked={remember()} label="Hidden files" onChange={setRemember} />
            <span>Hidden files</span>
          </div>
          <Slider value={volume()} label="Volume" onInput={setVolume} />
          <ProgressBar value={0.42} label="Copying" />
          <ProgressBar value={null} label="Working" />
        </div>
      </Dialog>
      <Toasts />
    </div>
  )
}
