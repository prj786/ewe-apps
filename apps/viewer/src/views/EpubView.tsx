// Books (EPUB, MOBI/AZW3, FB2) through foliate-js' <foliate-view>: paged or scrolled,
// contents, font size, light / dark / sepia pages, the place remembered as a CFI.

import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js'
import { rawUrl } from '@ewe/shared'
import {
  EmptyState,
  IconButton,
  Menu,
  ProgressBar,
  Segmented,
  Toolbar,
  addRecent,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import { openExternal } from '../lib/bridge'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName } from '../lib/kinds'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import { flagValue, hasFlag } from '../lib/flags'
import type { FoliateLocation, FoliateTocItem, FoliateView } from '../vendor/foliate-js/view'
import type { ViewProps } from './types'

type Flow = 'paged' | 'scrolled'
type Theme = 'light' | 'dark' | 'sepia' | 'auto'

const FONT_STEPS = [80, 90, 100, 110, 120, 135, 150, 175, 200]

const THEMES: Record<Exclude<Theme, 'auto'>, { bg: string; fg: string; link: string }> = {
  light: { bg: '#ffffff', fg: '#1b1b1b', link: '#1a5fb4' },
  dark: { bg: '#1e1e1e', fg: '#e3e3e3', link: '#99c1f1' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8b4513' },
}

function bookCss(theme: Exclude<Theme, 'auto'>, fontPercent: number): string {
  const t = THEMES[theme]
  // the book's own styles win on layout; we only set colours, size and spacing
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${theme === 'dark' ? 'dark' : 'light'}; }
    html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
    body { font-size: ${fontPercent}% !important; }
    a:link, a:visited { color: ${t.link}; }
    p, li, blockquote, dd { line-height: 1.5; -webkit-hyphens: auto; hyphens: auto; widows: 2; orphans: 2; }
    [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
    pre { white-space: pre-wrap !important; }
    img, svg, video { max-width: 100% !important; max-height: 100vh !important; object-fit: contain; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `
}

function titleOf(book: FoliateView['book']): string | null {
  const t = book.metadata?.title
  if (typeof t === 'string') return t
  if (t !== undefined && typeof t === 'object') return Object.values(t)[0] ?? null
  return null
}

function authorOf(book: FoliateView['book']): string | null {
  const a = book.metadata?.author
  const one = (v: unknown): string | null => {
    if (typeof v === 'string') return v
    if (v !== null && typeof v === 'object' && 'name' in v) {
      const n: unknown = v.name
      if (typeof n === 'string') return n
      if (n !== null && typeof n === 'object') {
        const first: unknown = Object.values(n)[0]
        return typeof first === 'string' ? first : null
      }
    }
    return null
  }
  if (Array.isArray(a))
    return (
      a
        .map(one)
        .filter((x): x is string => x !== null)
        .join(', ') || null
    )
  return one(a)
}

export function EpubView(props: ViewProps): JSX.Element {
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = createSignal('')
  const flags = () => props.flags ?? []
  const [flow, setFlow] = createSignal<Flow>(
    flagValue(flags(), 'flow') === 'scrolled' ? 'scrolled' : getSetting<Flow>('bookFlow', 'paged'),
  )
  const [theme, setTheme] = createSignal<Theme>(
    (['light', 'dark', 'sepia', 'auto'] as Theme[]).find(
      (t) => t === flagValue(flags(), 'theme'),
    ) ?? getSetting<Theme>('bookTheme', 'auto'),
  )
  const [fontPct, setFontPct] = createSignal(getSetting('bookFont', 100))
  const [toc, setToc] = createSignal<FoliateTocItem[]>([])
  const [showToc, setShowToc] = createSignal(
    hasFlag(flags(), 'toc') || getSetting('bookToc', false),
  )
  const [location, setLocation] = createSignal<FoliateLocation | null>(null)
  const [title, setTitle] = createSignal<string | null>(null)
  const [author, setAuthor] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)

  let host: HTMLDivElement | undefined
  let view: FoliateView | null = null
  let destroyed = false

  const systemDark = () => document.documentElement.dataset.theme !== 'light'
  const resolvedTheme = (): Exclude<Theme, 'auto'> =>
    theme() === 'auto' ? (systemDark() ? 'dark' : 'light') : (theme() as Exclude<Theme, 'auto'>)

  const applyStyles = () => {
    // the renderer only exists once open() has picked paginated / fixed layout
    view?.renderer?.setStyles(bookCss(resolvedTheme(), fontPct()))
  }

  const applyFlow = (f: Flow) => {
    if (view?.renderer === undefined) return
    view.renderer.setAttribute('flow', f)
    view?.renderer.setAttribute('gap', '6%')
    view?.renderer.setAttribute('margin', '48px')
    view?.renderer.setAttribute('max-inline-size', '760px')
    view?.renderer.setAttribute('max-column-count', '2')
  }

  onMount(() => {
    void (async () => {
      try {
        await import('../vendor/foliate-js/view.js')
        if (destroyed || host === undefined) return
        const el = document.createElement('foliate-view') as FoliateView
        view = el
        host.append(el)
        el.addEventListener('relocate', (e) => {
          const loc = (e as CustomEvent<FoliateLocation>).detail
          setLocation(loc)
          if (loc.cfi !== undefined && status() === 'ready')
            savePosition(props.path, { cfi: loc.cfi, mode: flow() })
        })
        el.addEventListener('external-link', (e) => {
          e.preventDefault()
          const href = (e as CustomEvent<{ href?: string; href_?: string }>).detail
          const url = href.href ?? href.href_
          if (url !== undefined)
            void openExternal(url).catch(() =>
              toast('Could not open the link', { kind: 'warning' }),
            )
        })
        el.addEventListener('load', (e) => {
          // keys pressed inside the book's iframe reach the app
          const { doc } = (e as CustomEvent<{ doc: Document }>).detail
          doc.addEventListener('keydown', (k) => {
            const copy = new KeyboardEvent('keydown', {
              key: k.key,
              code: k.code,
              ctrlKey: k.ctrlKey,
              shiftKey: k.shiftKey,
              altKey: k.altKey,
              metaKey: k.metaKey,
              bubbles: true,
              cancelable: true,
            })
            if (!window.dispatchEvent(copy)) k.preventDefault()
          })
        })
        const response = await fetch(rawUrl(props.server, props.path))
        if (!response.ok) throw new Error(`Could not read ${baseName(props.path)}`)
        const blob = await response.blob()
        const file = new File([blob], baseName(props.path))
        await el.open(file)
        if (destroyed) return
        applyFlow(flow())
        applyStyles()
        setToc(el.book.toc ?? [])
        const t = titleOf(el.book)
        setTitle(t)
        setAuthor(authorOf(el.book))
        if (t !== null) props.onTitle?.(t)
        const saved = await recallPosition(props.path)
        if (
          flagValue(flags(), 'flow') === null &&
          (saved?.mode === 'paged' || saved?.mode === 'scrolled')
        ) {
          setFlow(saved.mode)
          applyFlow(saved.mode)
        }
        await el.init({ lastLocation: saved?.cfi, showTextStart: saved?.cfi === undefined })
        setStatus('ready')
        void addRecent(props.path, 'application/epub+zip').catch(() => undefined)
      } catch (e) {
        if (destroyed) return
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    onCleanup(() => {
      destroyed = true
      try {
        view?.close()
      } catch {
        // already gone
      }
      view?.remove()
      view = null
    })
  })

  createEffect(on([theme, fontPct], applyStyles, { defer: true }))
  // follow the desktop theme while on Auto
  onMount(() => {
    const mo = new MutationObserver(() => {
      if (theme() === 'auto') applyStyles()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    onCleanup(() => mo.disconnect())
  })

  const changeFlow = (f: Flow) => {
    setFlow(f)
    setSetting('bookFlow', f)
    applyFlow(f)
  }
  const changeTheme = (t: Theme) => {
    setTheme(t)
    setSetting('bookTheme', t)
  }
  const stepFont = (delta: 1 | -1) => {
    const i = FONT_STEPS.indexOf(fontPct())
    const next =
      FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, (i === -1 ? 2 : i) + delta))]
    if (next !== undefined) {
      setFontPct(next)
      setSetting('bookFont', next)
    }
  }

  const next = () => void view?.next()
  const prev = () => void view?.prev()

  useKeys(
    () => props.active,
    (e) => {
      if (isMod(e)) {
        if (e.key === '=' || e.key === '+') {
          stepFont(1)
          return true
        }
        if (e.key === '-') {
          stepFont(-1)
          return true
        }
        if (e.key === '0') {
          setFontPct(100)
          setSetting('bookFont', 100)
          return true
        }
        return false
      }
      if (inTextInput(e)) return false
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
        case 'j':
        case 'n':
          if (e.key === ' ' && e.shiftKey) prev()
          else next()
          return true
        case 'ArrowLeft':
        case 'PageUp':
        case 'k':
        case 'p':
          prev()
          return true
        case 'ArrowDown':
        case 'ArrowUp':
          if (flow() === 'scrolled') return false
          if (e.key === 'ArrowDown') next()
          else prev()
          return true
        case 'Home':
          void view?.goToFraction(0)
          return true
        case 'End':
          void view?.goToFraction(1)
          return true
        case 't':
        case 'o':
          toggleToc()
          return true
        default:
          return false
      }
    },
  )

  const toggleToc = () => {
    setShowToc((v) => {
      setSetting('bookToc', !v)
      return !v
    })
  }

  const progress = () => {
    const loc = location()
    if (loc === null) return ''
    const parts: string[] = []
    if (loc.location !== undefined && loc.location.total > 0)
      parts.push(`${loc.location.current + 1} of ${loc.location.total}`)
    if (loc.fraction !== undefined) parts.push(`${Math.round(loc.fraction * 100)}%`)
    if (loc.time !== undefined && loc.time.total > 0)
      parts.push(`${Math.max(1, Math.round(loc.time.total))} min left`)
    return parts.join(' · ')
  }

  const items = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'theme',
      label: 'Page colours',
      icon: 'sun',
      items: (['auto', 'light', 'sepia', 'dark'] as Theme[]).map((t): MenuEntry => ({
        type: 'item',
        id: t,
        label: t === 'auto' ? 'Follow the desktop' : t.charAt(0).toUpperCase() + t.slice(1),
        dot: theme() === t ? 'var(--accent)' : undefined,
        run: () => changeTheme(t),
      })),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'start',
      label: 'Go to the beginning',
      icon: 'arrow-up',
      hint: 'Home',
      run: () => void view?.goToFraction(0),
    },
  ]

  const TocTree = (p: { items: FoliateTocItem[]; depth: number }): JSX.Element => (
    <ul class="pdf-outline" role={p.depth === 0 ? 'tree' : 'group'}>
      <For each={p.items}>
        {(item) => (
          <li role="treeitem">
            <div class="pdf-outline-row" style={{ '--depth': p.depth }}>
              <span class="pdf-outline-gap" />
              <button
                type="button"
                class="pdf-outline-link"
                classList={{
                  current: location()?.tocItem?.href === item.href && item.href !== undefined,
                }}
                onClick={() => {
                  if (item.href !== undefined) void view?.goTo(item.href)
                }}
              >
                {item.label}
              </button>
            </div>
            <Show when={(item.subitems ?? []).length > 0}>
              <TocTree items={item.subitems ?? []} depth={p.depth + 1} />
            </Show>
          </li>
        )}
      </For>
    </ul>
  )

  return (
    <div class="bk" classList={{ [`bk--${resolvedTheme()}`]: true }}>
      <Toolbar label="Book" class="view-toolbar">
        <IconButton icon="list-tree" label="Contents (T)" active={showToc()} onClick={toggleToc} />
        <span class="view-title">
          <span class="view-name" dir="auto">
            {title() ?? baseName(props.path)}
          </span>
          <span class="view-meta">
            {[author(), progress()].filter((x) => x !== null && x !== '').join(' · ')}
          </span>
        </span>
        <span class="toolbar-spacer" />
        <Segmented
          small
          value={flow()}
          label="Layout"
          options={[
            { value: 'paged', label: 'Pages' },
            { value: 'scrolled', label: 'Scroll' },
          ]}
          onChange={(v) => changeFlow(v as Flow)}
        />
        <span class="toolbar-divider" />
        <IconButton icon="zoom-out" label="Smaller text (Ctrl+−)" onClick={() => stepFont(-1)} />
        <span class="bk-font">{fontPct()}%</span>
        <IconButton icon="zoom-in" label="Larger text (Ctrl++)" onClick={() => stepFont(1)} />
        <IconButton
          icon="ellipsis"
          label="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.right, y: r.bottom + 4 })
          }}
        />
      </Toolbar>
      <div class="bk-body">
        <Show when={showToc()}>
          <aside class="pdf-side">
            <div class="pdf-side-head">
              <span class="pdf-side-title">Contents</span>
            </div>
            <div class="pdf-side-body">
              <Show
                when={toc().length > 0}
                fallback={<EmptyState icon="list-tree" title="No contents" compact />}
              >
                <TocTree items={toc()} depth={0} />
              </Show>
            </div>
          </aside>
        </Show>
        <div class="bk-stage">
          <div ref={host} class="bk-host" />
          <Show when={status() === 'ready' && flow() === 'paged'}>
            <button class="iv-nav prev bk-nav" aria-label="Previous page" onClick={prev}>
              <span class="iv-nav-glyph">‹</span>
            </button>
            <button class="iv-nav next bk-nav" aria-label="Next page" onClick={next}>
              <span class="iv-nav-glyph">›</span>
            </button>
          </Show>
          <Show when={status() === 'loading'}>
            <div class="view-loading">
              <ProgressBar value={null} label="Opening the book" />
            </div>
          </Show>
          <Show when={status() === 'error'}>
            <div class="view-center">
              <EmptyState icon="book" title="Could not open this book" warning>
                {error()}
              </EmptyState>
            </div>
          </Show>
        </div>
      </div>
      <Show when={location()?.fraction !== undefined}>
        <div class="bk-progress" aria-hidden="true">
          <div
            class="bk-progress-fill"
            style={{ width: `${(location()?.fraction ?? 0) * 100}%` }}
          />
        </div>
      </Show>
      <Show when={menuAt()}>
        {(at) => <Menu items={items()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
    </div>
  )
}
