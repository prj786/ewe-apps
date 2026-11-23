// Comics (CBZ / CBR / CB7 / CBT): the core lists and extracts the pages, the view shows
// one page or a two-page spread, fit height / fit width, and remembers the page.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import {
  EmptyState,
  IconButton,
  ProgressBar,
  Segmented,
  Switch as Toggle,
  Toolbar,
  addRecent,
} from '@ewe/ui'
import { comicList, comicPage } from '../lib/bridge'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName } from '../lib/kinds'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import { flagNumber, hasFlag } from '../lib/flags'
import { wheelStepper } from '../lib/wheel'
import type { ViewProps } from './types'

type Fit = 'height' | 'width'

export function ComicView(props: ViewProps): JSX.Element {
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = createSignal('')
  const [pages, setPages] = createSignal<string[]>([])
  const [source, setSource] = createSignal('zip')
  const [page, setPage] = createSignal(1)
  const [pageText, setPageText] = createSignal('1')
  const flags = () => props.flags ?? []
  const [spread, setSpread] = createSignal(
    hasFlag(flags(), 'spread') || getSetting('comicSpread', false),
  )
  const [coverAlone, setCoverAlone] = createSignal(getSetting('comicCoverAlone', true))
  const [rtl, setRtl] = createSignal(getSetting('comicRtl', false))
  const [fit, setFit] = createSignal<Fit>(getSetting<Fit>('comicFit', 'height'))
  const [urls, setUrls] = createSignal<Record<number, string>>({})
  const [failedPages, setFailedPages] = createSignal<Set<number>>(new Set())

  let destroyed = false
  const cache = new Map<number, string>()
  const loading = new Set<number>()
  let stage: HTMLDivElement | undefined
  let pageInput: HTMLInputElement | undefined

  const count = () => pages().length

  const fetchPage = async (n: number) => {
    if (n < 1 || n > count() || cache.has(n) || loading.has(n)) return
    const name = pages()[n - 1]
    if (name === undefined) return
    loading.add(n)
    try {
      const blob = await comicPage(props.path, name, source())
      if (destroyed) return
      const url = URL.createObjectURL(blob)
      cache.set(n, url)
      setUrls((u) => ({ ...u, [n]: url }))
    } catch {
      setFailedPages((s) => new Set(s).add(n))
    } finally {
      loading.delete(n)
    }
    // keep ~12 pages around the current one
    for (const [k, url] of cache) {
      if (Math.abs(k - page()) > 6) {
        URL.revokeObjectURL(url)
        cache.delete(k)
        setUrls((u) => Object.fromEntries(Object.entries(u).filter(([key]) => Number(key) !== k)))
      }
    }
  }

  /** Pages shown right now: [n] or [n, n+1] in a spread (the cover alone when asked). */
  const visible = createMemo((): number[] => {
    const n = page()
    const total = count()
    if (!spread() || total < 2) return [n]
    const offset = coverAlone() ? 1 : 0
    if (coverAlone() && n === 1) return [1]
    // spreads start on even pages when the cover stands alone
    const first = (n - offset) % 2 === 1 ? n : n - 1
    const left = Math.max(1 + offset, first)
    const list = [left, left + 1].filter((p) => p >= 1 && p <= total)
    return rtl() ? list.reverse() : list
  })

  const stepBy = () => (spread() ? 2 : 1)

  const goTo = (n: number) => {
    const clamped = Math.max(1, Math.min(count(), Math.round(n)))
    setPage(clamped)
    setPageText(String(clamped))
    if (status() === 'ready') savePosition(props.path, { page: clamped })
  }
  const next = () => {
    const shown = visible()
    const last = Math.max(...shown)
    if (last < count()) goTo(last + 1)
  }
  const prev = () => {
    const shown = visible()
    const first = Math.min(...shown)
    if (first > 1) goTo(Math.max(1, first - stepBy()))
  }

  // `pages` too: the list arrives after the first run, and when the book opens on page
  // 1 neither `page` nor `spread` changes again — "Loading page 1" stayed for ever
  createEffect(
    on([page, spread, pages], () => {
      for (const n of visible()) void fetchPage(n)
      for (const d of [1, 2, -1, -2, 3, 4]) void fetchPage(page() + d)
    }),
  )

  onMount(() => {
    void (async () => {
      try {
        const listing = await comicList(props.path)
        if (destroyed) return
        if (listing.pages.length === 0) throw new Error('No pages were found in this archive.')
        setPages(listing.pages)
        setSource(listing.source)
        const saved = await recallPosition(props.path)
        const wanted = flagNumber(flags(), 'page') ?? saved?.page
        const start =
          wanted !== undefined && wanted !== null && wanted >= 1 && wanted <= listing.pages.length
            ? wanted
            : 1
        setPage(start)
        setPageText(String(start))
        setStatus('ready')
        void addRecent(props.path).catch(() => undefined)
      } catch (e) {
        if (destroyed) return
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    onCleanup(() => {
      destroyed = true
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    })
  })

  useKeys(
    () => props.active,
    (e) => {
      if (isMod(e)) return false
      if (inTextInput(e)) return false
      switch (e.key) {
        case 'ArrowRight':
          if (rtl()) prev()
          else next()
          return true
        case 'ArrowLeft':
          if (rtl()) next()
          else prev()
          return true
        case ' ':
        case 'PageDown':
        case 'j':
        case 'n':
          if (e.key === ' ' && e.shiftKey) prev()
          else next()
          return true
        case 'PageUp':
        case 'k':
        case 'p':
        case 'Backspace':
          prev()
          return true
        case 'Home':
          goTo(1)
          return true
        case 'End':
          goTo(count())
          return true
        case 'g':
          pageInput?.focus()
          pageInput?.select()
          return true
        case 'd':
          toggleSpread()
          return true
        case 'w':
          changeFit(fit() === 'width' ? 'height' : 'width')
          return true
        default:
          return false
      }
    },
  )

  const toggleSpread = () => {
    setSpread((v) => {
      setSetting('comicSpread', !v)
      return !v
    })
  }
  const changeFit = (f: Fit) => {
    setFit(f)
    setSetting('comicFit', f)
  }

  // one page per notch, or per swipe of a touchpad (not per event of the swipe)
  const flip = wheelStepper({ once: true })
  const onWheel = (e: WheelEvent) => {
    if (fit() === 'width') return // natural scrolling down the page
    e.preventDefault()
    const dir = flip(e)
    if (dir > 0) next()
    else if (dir < 0) prev()
  }

  return (
    <div class="cb">
      <Toolbar label="Comic" class="view-toolbar">
        <span class="view-title">
          <span class="view-name" dir="auto">
            {baseName(props.path)}
          </span>
          <span class="view-meta">
            {count() > 0 ? `${count()} pages` : ''}
            {source() !== 'zip' && status() === 'ready' ? ` · read with ${source()}` : ''}
          </span>
        </span>
        <span class="toolbar-spacer" />
        <IconButton
          icon="chevron-left"
          label="Previous page"
          disabled={Math.min(...visible()) <= 1}
          onClick={prev}
        />
        <form
          class="pdf-pagebox"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number(pageText())
            if (Number.isFinite(n)) goTo(n)
            else setPageText(String(page()))
            stage?.focus()
          }}
        >
          <input
            ref={pageInput}
            class="field-input pdf-pagenum"
            type="text"
            inputmode="numeric"
            aria-label="Page number"
            value={pageText()}
            onInput={(e) => setPageText(e.currentTarget.value)}
            onBlur={() => setPageText(String(page()))}
          />
          <span class="pdf-pagecount">of {count()}</span>
        </form>
        <IconButton
          icon="chevron-right"
          label="Next page"
          disabled={Math.max(...visible()) >= count()}
          onClick={next}
        />
        <span class="toolbar-divider" />
        <Segmented
          small
          value={fit()}
          label="Fit"
          options={[
            { value: 'height', label: 'Fit page' },
            { value: 'width', label: 'Fit width' },
          ]}
          onChange={(v) => changeFit(v as Fit)}
        />
        <IconButton
          icon="columns-2"
          label={spread() ? 'One page (D)' : 'Two-page spread (D)'}
          active={spread()}
          onClick={toggleSpread}
        />
      </Toolbar>
      <Show when={spread()}>
        <div class="cb-options">
          <Toggle
            checked={coverAlone()}
            label="Cover on its own"
            onChange={(v) => {
              setCoverAlone(v)
              setSetting('comicCoverAlone', v)
            }}
          />
          <span>Cover on its own</span>
          <Toggle
            checked={rtl()}
            label="Right to left (manga)"
            onChange={(v) => {
              setRtl(v)
              setSetting('comicRtl', v)
            }}
          />
          <span>Right to left</span>
        </div>
      </Show>
      <div
        ref={stage}
        class="cb-stage"
        classList={{
          'cb-stage--width': fit() === 'width',
          'cb-stage--spread': visible().length > 1,
        }}
        tabindex="-1"
        onWheel={onWheel}
        onClick={(e) => {
          if (status() !== 'ready') return
          const r = e.currentTarget.getBoundingClientRect()
          const leftSide = e.clientX - r.left < r.width / 2
          if (leftSide === !rtl()) prev()
          else next()
        }}
      >
        <Show when={status() === 'ready'}>
          <For each={visible()}>
            {(n) => (
              <Show
                when={urls()[n]}
                fallback={
                  <div class="cb-page cb-page--empty">
                    <Show
                      when={failedPages().has(n)}
                      fallback={<ProgressBar value={null} label={`Loading page ${n}`} />}
                    >
                      <EmptyState
                        icon="circle-alert"
                        title={`Page ${n} could not be read`}
                        compact
                        warning
                      />
                    </Show>
                  </div>
                }
              >
                {(url) => <img class="cb-page" src={url()} alt={`Page ${n}`} draggable={false} />}
              </Show>
            )}
          </For>
        </Show>
        <Show when={status() === 'loading'}>
          <div class="view-loading">
            <ProgressBar value={null} label="Opening the comic" />
          </div>
        </Show>
        <Show when={status() === 'error'}>
          <div class="view-center">
            <EmptyState icon="images" title="Could not open this comic" warning>
              {error()}
            </EmptyState>
          </div>
        </Show>
      </div>
    </div>
  )
}
