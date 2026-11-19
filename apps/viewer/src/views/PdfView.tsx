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
import { getCurrentWindow } from '@tauri-apps/api/window'
import { save } from '@tauri-apps/plugin-dialog'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import { formatBytes, rawUrl } from '@ewe/shared'
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
  Toolbar,
  addRecent,
  toast,
  type MenuEntry,
} from '@ewe/ui'
import { fileStat, openExternal, saveBytes } from '../lib/bridge'
import { inTextInput, isMod, useKeys } from '../lib/keys'
import { baseName } from '../lib/kinds'
import { sanitizeZoom } from '../lib/memory'
import { fillFlags, flagNumber, flagValue, hasFlag } from '../lib/flags'
import { DOCUMENT_OPTIONS, loadPdfJs, loadPdfViewer } from '../lib/pdfjs'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import { printPages } from '../lib/print'
import { percent, zoomStep, type ViewProps } from './types'

type Mode = 'continuous' | 'single' | 'two'
type Side = 'none' | 'thumbs' | 'outline'

interface OutlineItem {
  title: string
  dest: unknown
  url: string | null
  items: OutlineItem[]
}

interface PendingPassword {
  update: (password: string) => void
  wrong: boolean
}

const FITS = [
  { value: 'page-width', label: 'Fit width' },
  { value: 'page-fit', label: 'Fit page' },
  { value: '1', label: 'Actual size' },
]

function mapOutline(items: unknown): OutlineItem[] {
  if (!Array.isArray(items)) return []
  return items.map((raw) => {
    const item = raw as { title?: string; dest?: unknown; url?: string | null; items?: unknown }
    return {
      title: item.title ?? '',
      dest: item.dest ?? null,
      url: item.url ?? null,
      items: mapOutline(item.items),
    }
  })
}

function pdfDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // D:YYYYMMDDHHmmSS…
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw)
  if (m === null) return raw
  const d = new Date(
    Number(m[1]),
    Number(m[2] ?? 1) - 1,
    Number(m[3] ?? 1),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  )
  return Number.isNaN(d.getTime())
    ? raw
    : d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}

function pageSize(widthPt: number, heightPt: number): string {
  const mm = (pt: number) => Math.round((pt / 72) * 25.4)
  const inch = (pt: number) => (pt / 72).toFixed(1)
  const w = mm(widthPt)
  const h = mm(heightPt)
  let name = ''
  const near = (a: number, b: number, c: number, d: number) =>
    Math.abs(a - c) <= 2 && Math.abs(b - d) <= 2
  if (near(w, h, 210, 297) || near(w, h, 297, 210)) name = 'A4'
  else if (near(w, h, 216, 279) || near(w, h, 279, 216)) name = 'Letter'
  else if (near(w, h, 148, 210) || near(w, h, 210, 148)) name = 'A5'
  else if (near(w, h, 297, 420) || near(w, h, 420, 297)) name = 'A3'
  const orientation = w > h ? 'landscape' : 'portrait'
  return `${w} × ${h} mm (${inch(widthPt)} × ${inch(heightPt)} in${name === '' ? '' : `, ${name}`}, ${orientation})`
}

export function PdfView(props: ViewProps): JSX.Element {
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = createSignal('')
  const [page, setPage] = createSignal(1)
  const [pageText, setPageText] = createSignal('1')
  const [count, setCount] = createSignal(0)
  const [scale, setScale] = createSignal(1)
  const [scaleValue, setScaleValue] = createSignal('page-width')
  const [mode, setMode] = createSignal<Mode>('continuous')
  const [rotation, setRotation] = createSignal(0)
  const [side, setSide] = createSignal<Side>(getSetting<Side>('pdfSide', 'none'))
  const flags = () => props.flags ?? []
  const [night, setNight] = createSignal(hasFlag(flags(), 'night') || getSetting('pdfNight', false))
  const [findOpen, setFindOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [matches, setMatches] = createSignal<{ current: number; total: number } | null>(null)
  const [notFound, setNotFound] = createSignal(false)
  const [outline, setOutline] = createSignal<OutlineItem[]>([])
  const [password, setPassword] = createSignal<PendingPassword | null>(null)
  const [passwordText, setPasswordText] = createSignal('')
  const [properties, setProperties] = createSignal<{ label: string; value: string }[] | null>(null)
  const [presentation, setPresentation] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [printing, setPrinting] = createSignal<{ done: number; total: number } | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [zoomMenuAt, setZoomMenuAt] = createSignal<{ x: number; y: number } | null>(null)
  const [thumbsReady, setThumbsReady] = createSignal(0)

  let container: HTMLDivElement | undefined
  let viewerEl: HTMLDivElement | undefined
  let findInput: HTMLInputElement | undefined
  let pageInput: HTMLInputElement | undefined
  let pdfViewer: PDFViewer | null = null
  let eventBus: EventBus | null = null
  let linkService: PDFLinkService | null = null
  let findController: PDFFindController | null = null
  let doc: PDFDocumentProxy | null = null
  let task: { destroy(): Promise<void> } | null = null
  let destroyed = false
  let beforePresentation: { mode: Mode; scaleValue: string } | null = null
  let restoring = true
  let printCancel: (() => void) | null = null
  const thumbCanvases = new Map<number, HTMLCanvasElement>()
  const thumbRendered = new Set<number>()
  let thumbObserver: IntersectionObserver | null = null

  const url = () => rawUrl(props.server, props.path)
  const name = () => baseName(props.path)

  const applyMode = (m: Mode) => {
    if (pdfViewer === null) return
    const { ScrollMode, SpreadMode } = modes
    if (m === 'single') {
      pdfViewer.spreadMode = SpreadMode.NONE
      pdfViewer.scrollMode = ScrollMode.PAGE
    } else if (m === 'two') {
      pdfViewer.scrollMode = ScrollMode.VERTICAL
      pdfViewer.spreadMode = SpreadMode.ODD
    } else {
      pdfViewer.spreadMode = SpreadMode.NONE
      pdfViewer.scrollMode = ScrollMode.VERTICAL
    }
  }
  let modes = { ScrollMode: { VERTICAL: 0, PAGE: 3 }, SpreadMode: { NONE: 0, ODD: 1 } }

  const changeMode = (m: Mode) => {
    setMode(m)
    applyMode(m)
    persist()
  }

  const persist = () => {
    if (restoring || status() !== 'ready') return
    savePosition(props.path, {
      page: page(),
      zoom: sanitizeZoom(scaleValue()),
      mode: mode(),
      rotation: rotation(),
    })
  }

  const setZoom = (value: string | number) => {
    if (pdfViewer === null) return
    pdfViewer.currentScaleValue = String(value)
  }
  const zoomBy = (delta: 1 | -1) => setZoom(zoomStep(scale(), delta))

  const goTo = (n: number) => {
    if (pdfViewer === null) return
    const clamped = Math.max(1, Math.min(count(), Math.round(n)))
    pdfViewer.currentPageNumber = clamped
  }

  const doFind = (type: '' | 'again', previous = false) => {
    if (eventBus === null) return
    eventBus.dispatch('find', {
      source: null,
      type,
      query: query(),
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    })
  }

  const openFind = () => {
    setFindOpen(true)
    queueMicrotask(() => {
      findInput?.focus()
      findInput?.select()
    })
  }
  const closeFind = () => {
    setFindOpen(false)
    setMatches(null)
    setNotFound(false)
    eventBus?.dispatch('findbarclose', { source: null })
    container?.focus()
  }

  const rotate = (delta: number) => {
    if (pdfViewer === null) return
    pdfViewer.pagesRotation = (pdfViewer.pagesRotation + delta + 360) % 360
  }

  const toggleNight = () => {
    setNight((v) => {
      setSetting('pdfNight', !v)
      return !v
    })
  }

  const toggleSide = (which: Side, persist = true) => {
    const next = side() === which ? 'none' : which
    setSide(next)
    if (persist) setSetting('pdfSide', next)
    queueMicrotask(() => pdfViewer?.update())
  }

  const enterPresentation = async () => {
    if (pdfViewer === null) return
    beforePresentation = { mode: mode(), scaleValue: scaleValue() }
    setPresentation(true)
    try {
      await getCurrentWindow().setFullscreen(true)
    } catch {
      // not fatal: the chrome hides anyway
    }
    setMode('single')
    applyMode('single')
    requestAnimationFrame(() => {
      setZoom('page-fit')
      container?.focus()
    })
  }

  const leavePresentation = async () => {
    if (!presentation()) return
    setPresentation(false)
    try {
      await getCurrentWindow().setFullscreen(false)
    } catch {
      // ignore
    }
    const before = beforePresentation
    beforePresentation = null
    if (before !== null) {
      setMode(before.mode)
      applyMode(before.mode)
      requestAnimationFrame(() => setZoom(before.scaleValue))
    }
  }

  const saveCopy = async () => {
    if (doc === null) return
    const target = await save({
      defaultPath: props.path.replace(/\.pdf$/i, '') + ' (copy).pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      title: 'Save a copy',
    })
    if (target === null) return
    try {
      const bytes = await doc.saveDocument()
      await saveBytes(target, bytes)
      setDirty(false)
      toast(`Saved ${baseName(target)}`, { kind: 'success' })
    } catch (e) {
      toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, { kind: 'danger' })
    }
  }

  const print = async () => {
    if (doc === null || printing() !== null) return
    setPrinting({ done: 0, total: doc.numPages })
    const job = printPages(doc, rotation(), (done, total) => setPrinting({ done, total }))
    printCancel = () => job.cancel()
    try {
      const ok = await job.ready
      if (ok) {
        setPrinting(null)
        await new Promise((r) => requestAnimationFrame(r))
        window.print()
      }
    } catch (e) {
      toast(`Could not prepare the pages: ${e instanceof Error ? e.message : String(e)}`, {
        kind: 'danger',
      })
    } finally {
      setPrinting(null)
      printCancel = null
      job.cleanup()
    }
  }

  const showProperties = async () => {
    if (doc === null) return
    const rows: { label: string; value: string }[] = []
    const push = (label: string, value: unknown) => {
      if (typeof value === 'string' && value.trim() !== '')
        rows.push({ label, value: value.trim() })
      else if (typeof value === 'number') rows.push({ label, value: String(value) })
    }
    try {
      const [meta, stat, first] = await Promise.all([
        doc.getMetadata(),
        fileStat(props.path).catch(() => null),
        doc.getPage(1),
      ])
      const info = meta.info as Record<string, unknown>
      push('File', name())
      if (stat !== null) push('Size', formatBytes(stat.size))
      push('Title', info.Title)
      push('Author', info.Author)
      push('Subject', info.Subject)
      push('Keywords', info.Keywords)
      push('Created', pdfDate(info.CreationDate))
      push('Modified', pdfDate(info.ModDate))
      push('Application', info.Creator)
      push('PDF producer', info.Producer)
      push('PDF version', info.PDFFormatVersion)
      push('Pages', doc.numPages)
      const vp = first.getViewport({ scale: 1 })
      push('Page size', pageSize(vp.width, vp.height))
      push('Fast web view', info.IsLinearized === true ? 'Yes' : 'No')
      if (meta.metadata !== null && typeof meta.metadata === 'object') {
        const xmpTitle = (meta.metadata as { get?: (k: string) => unknown }).get?.('dc:title')
        if (rows.every((r) => r.label !== 'Title') && typeof xmpTitle === 'string')
          push('Title', xmpTitle)
      }
    } catch {
      // show what we have
    }
    setProperties(rows)
  }

  const renderThumb = async (n: number, canvas: HTMLCanvasElement) => {
    if (doc === null || thumbRendered.has(n)) return
    thumbRendered.add(n)
    try {
      const pg = await doc.getPage(n)
      const base = pg.getViewport({ scale: 1 })
      const width = 128
      const ratio = window.devicePixelRatio || 1
      const vp = pg.getViewport({ scale: (width / base.width) * ratio })
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      canvas.style.width = `${width}px`
      canvas.style.height = `${Math.round(vp.height / ratio)}px`
      await pg.render({ canvas, viewport: vp }).promise
    } catch {
      thumbRendered.delete(n)
    }
  }

  const observeThumb = (n: number, canvas: HTMLCanvasElement) => {
    thumbCanvases.set(n, canvas)
    thumbObserver ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = Number((entry.target as HTMLElement).dataset.page)
          const c = thumbCanvases.get(idx)
          if (c !== undefined) void renderThumb(idx, c)
        }
      },
      { rootMargin: '200px' },
    )
    thumbObserver.observe(canvas)
  }

  onMount(() => {
    void (async () => {
      const [pdfjs, web] = await Promise.all([loadPdfJs(), loadPdfViewer()])
      if (destroyed || container === undefined || viewerEl === undefined) return
      modes = { ScrollMode: web.ScrollMode, SpreadMode: web.SpreadMode }
      eventBus = new web.EventBus()
      linkService = new web.PDFLinkService({ eventBus, externalLinkTarget: web.LinkTarget.BLANK })
      findController = new web.PDFFindController({ eventBus, linkService })
      pdfViewer = new web.PDFViewer({
        container,
        viewer: viewerEl,
        eventBus,
        linkService,
        findController,
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
        textLayerMode: 1,
        imageResourcesPath: '/pdfjs/images/',
        enablePrintAutoRotate: true,
      })
      linkService.setViewer(pdfViewer)

      eventBus.on('pagesinit', () => {
        void (async () => {
          const saved = await recallPosition(props.path)
          if (destroyed || pdfViewer === null) return
          const m = (flagValue(flags(), 'mode') ?? saved?.mode ?? 'continuous') as Mode
          setMode(m === 'single' || m === 'two' ? m : 'continuous')
          applyMode(mode())
          const z =
            sanitizeZoom(flagValue(flags(), 'zoom') ?? undefined) ??
            sanitizeZoom(saved?.zoom) ??
            'page-width'
          pdfViewer.currentScaleValue = z
          if (saved?.rotation !== undefined && saved.rotation % 90 === 0)
            pdfViewer.pagesRotation = saved.rotation
          const wanted = flagNumber(flags(), 'page') ?? saved?.page
          if (wanted !== undefined && wanted !== null && wanted > 1 && wanted <= count())
            pdfViewer.currentPageNumber = wanted
          setStatus('ready')
          const sideFlag = flagValue(flags(), 'sidebar')
          if (sideFlag === 'pages' || sideFlag === 'thumbs') toggleSide('thumbs', false)
          else if (sideFlag === 'contents' || sideFlag === 'outline') toggleSide('outline', false)
          const findFlag = flagValue(flags(), 'find')
          if (findFlag !== null && findFlag !== '') {
            setQuery(findFlag)
            openFind()
            setTimeout(() => doFind(''), 300)
          }
          if (hasFlag(flags(), 'present')) setTimeout(() => void enterPresentation(), 300)
          requestAnimationFrame(() => {
            restoring = false
          })
        })()
      })
      eventBus.on('pagechanging', (e: { pageNumber: number }) => {
        setPage(e.pageNumber)
        setPageText(String(e.pageNumber))
        persist()
      })
      eventBus.on('scalechanging', (e: { scale: number; presetValue?: string | undefined }) => {
        setScale(e.scale)
        setScaleValue(
          e.presetValue !== undefined && e.presetValue !== '' ? e.presetValue : String(e.scale),
        )
        persist()
      })
      eventBus.on('rotationchanging', (e: { pagesRotation: number }) => {
        setRotation(e.pagesRotation)
        persist()
      })
      eventBus.on(
        'updatefindmatchescount',
        (e: { matchesCount: { current: number; total: number } }) => {
          setMatches(e.matchesCount)
        },
      )
      eventBus.on(
        'updatefindcontrolstate',
        (e: { state: number; matchesCount: { current: number; total: number } }) => {
          setMatches(e.matchesCount)
          setNotFound(e.state === web.FindState.NOT_FOUND)
        },
      )

      const loading = pdfjs.getDocument({ url: url(), ...DOCUMENT_OPTIONS })
      task = loading
      loading.onPassword = (update: (password: string) => void, reason: number) => {
        setPasswordText('')
        setPassword({ update, wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD })
      }
      try {
        doc = await loading.promise
      } catch (e) {
        if (destroyed) return
        setStatus('error')
        const msg = e instanceof Error ? e.message : String(e)
        setError(
          msg.includes('Password') || msg.includes('password')
            ? 'This PDF needs a password.'
            : msg.includes('Invalid PDF')
              ? 'This file is not a PDF that can be read.'
              : msg,
        )
        return
      }
      if (destroyed) {
        void loading.destroy()
        return
      }
      setPassword(null)
      setCount(doc.numPages)
      pdfViewer.setDocument(doc)
      linkService.setDocument(doc, null)
      const storage = doc.annotationStorage as unknown as {
        onSetModified: (() => void) | null
        onResetModified: (() => void) | null
      }
      storage.onSetModified = () => setDirty(true)
      storage.onResetModified = () => setDirty(false)
      setThumbsReady(doc.numPages)
      const fill = fillFlags(flags())
      if (Object.keys(fill).length > 0) {
        void doc.getFieldObjects().then((fields) => {
          if (fields === null || doc === null) return
          for (const [name, value] of Object.entries(fill)) {
            const list = (fields as Map<string, { id: string; type?: string }[]>).get(name) ?? []
            for (const f of list) {
              const v: unknown =
                f.type === 'checkbox' || f.type === 'radiobutton'
                  ? value !== 'Off' && value !== 'false'
                  : value
              doc.annotationStorage.setValue(f.id, { value: v })
            }
          }
          setDirty(true)
        })
      }
      void addRecent(props.path, 'application/pdf').catch(() => undefined)
      void doc
        .getOutline()
        .then((o) => setOutline(mapOutline(o)))
        .catch(() => undefined)
      void doc
        .getMetadata()
        .then((meta) => {
          const title = (meta.info as { Title?: unknown }).Title
          if (typeof title === 'string' && title.trim() !== '') props.onTitle?.(title.trim())
        })
        .catch(() => undefined)
    })().catch((e: unknown) => {
      if (destroyed) return
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    })

    // links: external ones open outside, local ones stay in pdf.js
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a')
      if (a === null) return
      const href = a.getAttribute('href') ?? ''
      if (/^(https?:|mailto:)/i.test(href)) {
        e.preventDefault()
        e.stopPropagation()
        void openExternal(href).catch(() => toast('Could not open the link', { kind: 'warning' }))
      }
    }
    container?.addEventListener('click', onClick, true)
    onCleanup(() => container?.removeEventListener('click', onClick, true))

    // Ctrl+wheel and touchpad pinch zoom
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1 : -1)
    }
    container?.addEventListener('wheel', onWheel, { passive: false })
    onCleanup(() => container?.removeEventListener('wheel', onWheel))
    let gestureScale = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureScale = scale()
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const g = (e as Event & { scale?: number }).scale
      if (g !== undefined) setZoom(Math.min(10, Math.max(0.1, gestureScale * g)))
    }
    container?.addEventListener('gesturestart', onGestureStart)
    container?.addEventListener('gesturechange', onGestureChange)
    onCleanup(() => {
      container?.removeEventListener('gesturestart', onGestureStart)
      container?.removeEventListener('gesturechange', onGestureChange)
    })

    // refit on resize when a fit is chosen
    const ro = new ResizeObserver(() => {
      if (pdfViewer === null || status() !== 'ready') return
      const v = scaleValue()
      if (v === 'page-width' || v === 'page-fit' || v === 'auto') pdfViewer.currentScaleValue = v
      else pdfViewer.update()
    })
    if (container !== undefined) ro.observe(container)
    onCleanup(() => ro.disconnect())

    onCleanup(() => {
      destroyed = true
      printCancel?.()
      thumbObserver?.disconnect()
      void task?.destroy()
      if (presentation()) void getCurrentWindow().setFullscreen(false)
    })
  })

  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) requestAnimationFrame(() => pdfViewer?.update())
      },
      { defer: true },
    ),
  )

  useKeys(
    () => props.active,
    (e) => {
      if (password() !== null || properties() !== null || printing() !== null) return false
      if (e.key === 'Escape') {
        if (presentation()) {
          void leavePresentation()
          return true
        }
        if (findOpen()) {
          closeFind()
          return true
        }
        return false
      }
      if (isMod(e) && !e.altKey) {
        switch (e.key) {
          case 'f':
            openFind()
            return true
          case '=':
          case '+':
            zoomBy(1)
            return true
          case '-':
            zoomBy(-1)
            return true
          case '0':
            setZoom('page-width')
            return true
          case 'p':
            void print()
            return true
          case 's':
            void saveCopy()
            return true
          case 'g':
            if (findOpen()) {
              doFind('again', e.shiftKey)
              return true
            }
            return false
          default:
            return false
        }
      }
      if (inTextInput(e)) return false
      if (e.key === 'F11' || e.key === 'F5') {
        if (presentation()) void leavePresentation()
        else void enterPresentation()
        return true
      }
      const paged = mode() !== 'continuous' || presentation()
      switch (e.key) {
        case 'j':
        case 'n':
          goTo(page() + 1)
          return true
        case 'k':
        case 'p':
          goTo(page() - 1)
          return true
        case 'ArrowRight':
          goTo(page() + 1)
          return true
        case 'ArrowLeft':
          goTo(page() - 1)
          return true
        case ' ':
        case 'PageDown':
          if (!paged && e.key === 'PageDown') return false
          if (e.key === ' ' && e.shiftKey) goTo(page() - 1)
          else goTo(page() + 1)
          return true
        case 'PageUp':
          if (!paged) return false
          goTo(page() - 1)
          return true
        case 'ArrowDown':
        case 'ArrowUp':
          if (!paged) return false
          goTo(page() + (e.key === 'ArrowDown' ? 1 : -1))
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
        case '+':
        case '=':
          zoomBy(1)
          return true
        case '-':
          zoomBy(-1)
          return true
        case 'r':
          rotate(e.shiftKey ? -90 : 90)
          return true
        case 'i':
          toggleNight()
          return true
        case 'w':
          setZoom('page-width')
          return true
        case 'f':
          setZoom('page-fit')
          return true
        case 't':
          toggleSide('thumbs')
          return true
        case 'o':
          toggleSide('outline')
          return true
        case '/':
          openFind()
          return true
        default:
          return false
      }
    },
  )

  const moreItems = (): MenuEntry[] => [
    {
      type: 'item',
      id: 'present',
      label: 'Presentation',
      icon: 'presentation',
      hint: 'F11',
      run: () => void enterPresentation(),
    },
    {
      type: 'item',
      id: 'print',
      label: 'Print…',
      icon: 'printer',
      hint: 'Ctrl+P',
      run: () => void print(),
    },
    {
      type: 'item',
      id: 'save',
      label: dirty() ? 'Save a copy with the filled fields…' : 'Save a copy…',
      icon: 'save',
      hint: 'Ctrl+S',
      run: () => void saveCopy(),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'rotate-left',
      label: 'Rotate left',
      icon: 'rotate-ccw',
      hint: 'Shift+R',
      run: () => rotate(-90),
    },
    {
      type: 'item',
      id: 'rotate-right',
      label: 'Rotate right',
      icon: 'rotate-cw',
      hint: 'R',
      run: () => rotate(90),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'props',
      label: 'Document properties',
      icon: 'info',
      run: () => void showProperties(),
    },
  ]

  const zoomItems = (): MenuEntry[] => [
    ...FITS.map((f): MenuEntry => ({
      type: 'item',
      id: f.value,
      label: f.label,
      dot: scaleValue() === f.value ? 'var(--accent)' : undefined,
      run: () => setZoom(f.value),
    })),
    { type: 'separator' },
    ...[50, 75, 100, 125, 150, 200, 300, 400].map((p): MenuEntry => ({
      type: 'item',
      id: `z${p}`,
      label: `${p}%`,
      dot: Math.round(scale() * 100) === p ? 'var(--accent)' : undefined,
      run: () => setZoom(p / 100),
    })),
  ]

  const matchLabel = () => {
    if (notFound()) return 'Not found'
    const m = matches()
    if (m === null || m.total === 0) return ''
    return `${m.current} of ${m.total}`
  }

  const printFraction = () => {
    const p = printing()
    return p === null || p.total === 0 ? null : p.done / p.total
  }

  const zoomLabel = createMemo(() => {
    const v = scaleValue()
    const fit = FITS.find((f) => f.value === v)
    return fit !== undefined && v !== '1' ? `${fit.label} · ${percent(scale())}` : percent(scale())
  })

  const OutlineTree = (p: { items: OutlineItem[]; depth: number }): JSX.Element => (
    <ul class="pdf-outline" role={p.depth === 0 ? 'tree' : 'group'}>
      <For each={p.items}>
        {(item) => {
          const [open, setOpen] = createSignal(p.depth < 1)
          return (
            <li role="treeitem" aria-expanded={item.items.length > 0 ? open() : undefined}>
              <div class="pdf-outline-row" style={{ '--depth': p.depth }}>
                <Show when={item.items.length > 0} fallback={<span class="pdf-outline-gap" />}>
                  <button
                    type="button"
                    class="pdf-outline-toggle"
                    aria-label={open() ? 'Collapse' : 'Expand'}
                    onClick={() => setOpen((o) => !o)}
                  >
                    <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={14} />
                  </button>
                </Show>
                <button
                  type="button"
                  class="pdf-outline-link"
                  onClick={() => {
                    if (item.url !== null) void openExternal(item.url).catch(() => undefined)
                    else if (item.dest !== null && linkService !== null)
                      void linkService.goToDestination(item.dest as string)
                  }}
                >
                  {item.title}
                </button>
              </div>
              <Show when={open() && item.items.length > 0}>
                <OutlineTree items={item.items} depth={p.depth + 1} />
              </Show>
            </li>
          )
        }}
      </For>
    </ul>
  )

  return (
    <div class="pdf" classList={{ 'pdf--night': night(), 'pdf--presentation': presentation() }}>
      <Toolbar label="PDF" class="view-toolbar">
        <IconButton
          icon="panel-left"
          label={side() === 'none' ? 'Show the sidebar (T)' : 'Hide the sidebar'}
          active={side() !== 'none'}
          onClick={() => toggleSide(side() === 'none' ? 'thumbs' : side())}
        />
        <span class="toolbar-divider" />
        <IconButton
          icon="chevron-up"
          label="Previous page (K)"
          disabled={page() <= 1}
          onClick={() => goTo(page() - 1)}
        />
        <form
          class="pdf-pagebox"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number(pageText())
            if (Number.isFinite(n)) goTo(n)
            else setPageText(String(page()))
            container?.focus()
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
          icon="chevron-down"
          label="Next page (J)"
          disabled={page() >= count()}
          onClick={() => goTo(page() + 1)}
        />
        <span class="toolbar-divider" />
        <IconButton icon="zoom-out" label="Zoom out (−)" onClick={() => zoomBy(-1)} />
        <button
          type="button"
          class="btn btn--ghost btn--sm pdf-zoom"
          aria-label="Zoom"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setZoomMenuAt({ x: r.left, y: r.bottom + 4 })
          }}
        >
          {zoomLabel()}
          <Icon name="chevron-down" size={14} />
        </button>
        <IconButton icon="zoom-in" label="Zoom in (+)" onClick={() => zoomBy(1)} />
        <span class="toolbar-divider" />
        <Segmented
          small
          value={mode()}
          label="Pages"
          options={[
            { value: 'continuous', label: 'Continuous' },
            { value: 'single', label: 'Single' },
            { value: 'two', label: 'Two pages' },
          ]}
          onChange={(v) => changeMode(v as Mode)}
        />
        <span class="toolbar-spacer" />
        <Show when={dirty()}>
          <Button small kind="primary" icon="save" onClick={() => void saveCopy()}>
            Save a copy
          </Button>
        </Show>
        <IconButton
          icon="search"
          label="Find (Ctrl+F)"
          active={findOpen()}
          onClick={() => (findOpen() ? closeFind() : openFind())}
        />
        <IconButton
          icon={night() ? 'sun' : 'moon'}
          label={night() ? 'Normal colours (I)' : 'Night mode (I)'}
          active={night()}
          onClick={toggleNight}
        />
        <IconButton
          icon="ellipsis"
          label="More"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.right, y: r.bottom + 4 })
          }}
        />
      </Toolbar>
      <Show when={findOpen()}>
        <div class="findbar" role="search">
          <Field
            value={query()}
            label="Find in document"
            placeholder="Find in document"
            icon="search"
            small
            clearable
            ref={(el) => {
              findInput = el
            }}
            onInput={(v) => {
              setQuery(v)
              doFind('')
            }}
            onSubmit={() => doFind('again', false)}
            onCancel={closeFind}
          />
          <span class="findbar-count" classList={{ 'findbar-count--none': notFound() }}>
            <Show when={query() !== ''}>{matchLabel()}</Show>
          </span>
          <IconButton
            icon="chevron-up"
            label="Previous match (Shift+Enter)"
            size="sm"
            onClick={() => doFind('again', true)}
          />
          <IconButton
            icon="chevron-down"
            label="Next match (Enter)"
            size="sm"
            onClick={() => doFind('again', false)}
          />
          <IconButton icon="x" label="Close find (Esc)" size="sm" onClick={closeFind} />
        </div>
      </Show>
      <div class="pdf-body">
        <Show when={side() !== 'none'}>
          <aside class="pdf-side">
            <div class="pdf-side-head">
              <Segmented
                small
                value={side()}
                label="Sidebar"
                options={[
                  { value: 'thumbs', label: 'Pages' },
                  { value: 'outline', label: 'Contents' },
                ]}
                onChange={(v) => toggleSide(v as Side)}
              />
            </div>
            <Show when={side() === 'thumbs'}>
              <div class="pdf-thumbs">
                <For each={Array.from({ length: thumbsReady() }, (_, i) => i + 1)}>
                  {(n) => (
                    <button
                      type="button"
                      class="pdf-thumb"
                      classList={{ current: page() === n }}
                      aria-label={`Page ${n}`}
                      aria-current={page() === n ? 'page' : undefined}
                      onClick={() => goTo(n)}
                      ref={(el) => {
                        createEffect(() => {
                          if (page() === n) el.scrollIntoView({ block: 'nearest' })
                        })
                      }}
                    >
                      <canvas data-page={n} ref={(c) => observeThumb(n, c)} />
                      <span class="pdf-thumb-num">{n}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={side() === 'outline'}>
              <div class="pdf-side-body">
                <Show
                  when={outline().length > 0}
                  fallback={
                    <EmptyState icon="list-tree" title="No contents" compact>
                      This PDF has no table of contents.
                    </EmptyState>
                  }
                >
                  <OutlineTree items={outline()} depth={0} />
                </Show>
              </div>
            </Show>
          </aside>
        </Show>
        <div class="pdf-stage">
          <div ref={container} class="pdf-container" tabindex="-1">
            <div ref={viewerEl} class="pdfViewer" />
          </div>
          <Show when={status() === 'loading' && password() === null}>
            <div class="view-loading">
              <ProgressBar value={null} label="Loading" />
            </div>
          </Show>
          <Show when={status() === 'error'}>
            <div class="view-center">
              <EmptyState icon="circle-alert" title="Could not open this PDF" warning>
                {error()}
              </EmptyState>
            </div>
          </Show>
        </div>
      </div>
      <Show when={presentation()}>
        <div class="pdf-present-hint">
          {page()} / {count()} · Esc leaves
        </div>
      </Show>
      <Show when={menuAt()}>
        {(at) => <Menu items={moreItems()} at={at()} onClose={() => setMenuAt(null)} />}
      </Show>
      <Show when={zoomMenuAt()}>
        {(at) => <Menu items={zoomItems()} at={at()} onClose={() => setZoomMenuAt(null)} />}
      </Show>
      <Dialog
        open={password() !== null}
        title="This PDF is locked"
        description={
          password()?.wrong === true
            ? 'That password did not open it. Try again.'
            : 'Type the password to open it.'
        }
        closable={false}
        onClose={() => {
          setPassword(null)
          setStatus('error')
          setError('This PDF needs a password.')
          props.onClose?.()
        }}
        actions={
          <>
            <Button kind="ghost" onClick={() => props.onClose?.()}>
              Cancel
            </Button>
            <Button
              kind="primary"
              onClick={() => {
                const p = password()
                if (p !== null) p.update(passwordText())
                setPassword(null)
              }}
            >
              Open
            </Button>
          </>
        }
      >
        <form
          class="pdf-password"
          onSubmit={(e) => {
            e.preventDefault()
            const p = password()
            if (p !== null) p.update(passwordText())
            setPassword(null)
          }}
        >
          <label class="field">
            <span class="field-icon">
              <Icon name="lock" />
            </span>
            <input
              class="field-input"
              type="password"
              aria-label="Password"
              placeholder="Password"
              value={passwordText()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setPasswordText(e.currentTarget.value)}
            />
          </label>
        </form>
      </Dialog>
      <Dialog
        open={properties() !== null}
        title="Document properties"
        onClose={() => setProperties(null)}
        actions={
          <Button kind="primary" onClick={() => setProperties(null)}>
            Done
          </Button>
        }
      >
        <dl class="info-rows">
          <For each={properties() ?? []}>
            {(row) => (
              <>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </>
            )}
          </For>
        </dl>
      </Dialog>
      <Dialog
        open={printing() !== null}
        title="Preparing to print"
        description={`Page ${printing()?.done ?? 0} of ${printing()?.total ?? 0}`}
        closable={false}
        onClose={() => printCancel?.()}
        actions={
          <Button kind="ghost" onClick={() => printCancel?.()}>
            Cancel
          </Button>
        }
      >
        <ProgressBar value={printFraction()} label="Rendering pages" />
      </Dialog>
    </div>
  )
}
