// PDFs through pdf.js: first-page thumbnails for tiles and a page-by-page quick look.

import { For, Show, createResource, createSignal, onCleanup, type JSX } from 'solid-js'
import * as pdfjs from 'pdfjs-dist'
// The worker module beside pdf.js in this chunk (which loads on first use: pdfthumb.ts,
// viewer.tsx): WebKitGTK refuses a module worker from the tauri:// scheme ("Load
// failed"), and pdf.js uses globalThis.pdfjsWorker when it is already there, so
// parsing runs on this thread. Fine for thumbnails and a look.
import 'pdfjs-dist/build/pdf.worker.min.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const thumbs = new Map<string, Promise<string | null>>()
const MAX_CACHED = 400

// pdf.js parses and draws on this thread (see the import above), so thumbnails are made
// one at a time with a breath between them, newest request first: a folder of PDFs
// used to start seventy documents at once and the pane stood still for seconds. What
// was asked for long ago (tiles scrolled out of the window) is dropped and can be
// asked for again.
interface ThumbJob {
  key: string
  run: () => Promise<string | null>
  done: (url: string | null) => void
}
const waiting: ThumbJob[] = []
const MAX_WAITING = 48
let working = false

function pump(): void {
  if (working) return
  const job = waiting.pop()
  if (job === undefined) return
  working = true
  void job.run().then((url) => {
    job.done(url)
    working = false
    // let a frame and the events of the meantime through before the next one
    setTimeout(pump, 0)
  })
}

async function drawThumb(url: string, size: number): Promise<string | null> {
  try {
    const task = pdfjs.getDocument({ url, disableAutoFetch: true })
    const doc = await task.promise
    try {
      const page = await doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const scale = size / Math.max(base.width, base.height)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      if (ctx === null) return null
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      return canvas.toDataURL('image/png')
    } finally {
      await task.destroy()
    }
  } catch {
    return null
  }
}

/** A PNG data URL of the first page, `size` px on the long side (cached per url). */
export function pdfThumb(url: string, size: number): Promise<string | null> {
  const key = `${size}:${url}`
  const cached = thumbs.get(key)
  if (cached !== undefined) return cached
  const job = new Promise<string | null>((resolve) => {
    waiting.push({ key, run: () => drawThumb(url, size), done: resolve })
    while (waiting.length > MAX_WAITING) {
      const old = waiting.shift()
      if (old === undefined) break
      thumbs.delete(old.key)
      old.done(null)
    }
  })
  if (thumbs.size >= MAX_CACHED) thumbs.clear()
  thumbs.set(key, job)
  pump()
  return job
}

function Page(props: {
  doc: PDFDocumentProxy
  index: number
  width: number
  /** height ÷ width of the first page: the room a page takes before it is drawn */
  ratio: number
}): JSX.Element {
  let cancelled = false
  let drawn = false
  onCleanup(() => {
    cancelled = true
  })
  const draw = async (el: HTMLCanvasElement) => {
    const page = await props.doc.getPage(props.index)
    if (cancelled) return
    const base = page.getViewport({ scale: 1 })
    const ratio = window.devicePixelRatio
    const scale = (props.width / base.width) * ratio
    const viewport = page.getViewport({ scale })
    el.width = Math.ceil(viewport.width)
    el.height = Math.ceil(viewport.height)
    el.style.width = `${props.width}px`
    el.style.height = `${Math.ceil(viewport.height / ratio)}px`
    const ctx = el.getContext('2d')
    if (ctx === null) return
    await page.render({ canvas: el, canvasContext: ctx, viewport }).promise
  }
  return (
    <canvas
      class="pdf-page"
      style={{ width: `${props.width}px`, height: `${Math.round(props.width * props.ratio)}px` }}
      ref={(el) => {
        // drawn when it comes near, not with the document: sixty pages at once were
        // sixty canvases of the stage's width drawn on the thread the window runs on
        const near = new IntersectionObserver(
          (entries) => {
            if (drawn || !entries.some((e) => e.isIntersecting)) return
            drawn = true
            near.disconnect()
            void draw(el)
          },
          { rootMargin: '800px 0px' },
        )
        near.observe(el)
        onCleanup(() => near.disconnect())
      }}
      aria-label={`Page ${props.index}`}
    />
  )
}

/** Continuous pages at the stage width; up to 60 pages, each drawn as it comes near. */
export function PdfView(props: { url: string; name: string }): JSX.Element {
  const [width, setWidth] = createSignal(720)
  const [ratio, setRatio] = createSignal(1.414)
  // registered here, while the component is being set up: after an `await` there is
  // no owner any more and the document was never let go
  let task: ReturnType<typeof pdfjs.getDocument> | null = null
  onCleanup(() => void task?.destroy())
  const [doc] = createResource(
    () => props.url,
    async (url) => {
      void task?.destroy()
      const mine = pdfjs.getDocument({ url })
      task = mine
      const d = await mine.promise
      const first = (await d.getPage(1)).getViewport({ scale: 1 })
      if (first.width > 0) setRatio(first.height / first.width)
      return d
    },
  )
  const pages = () => {
    const d = doc()
    if (d === undefined) return []
    return Array.from({ length: Math.min(d.numPages, 60) }, (_, i) => i + 1)
  }
  return (
    <div
      class="pdf"
      ref={(el) => {
        const ro = new ResizeObserver(() => setWidth(Math.min(900, el.clientWidth - 48)))
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      }}
    >
      <Show when={doc.error !== undefined}>
        <div class="tv-message">Could not open {props.name}</div>
      </Show>
      <Show when={doc.loading}>
        <div class="tv-message">Loading…</div>
      </Show>
      <Show when={doc()}>
        {(d) => (
          <>
            <For each={pages()}>
              {(i) => <Page doc={d()} index={i} width={width()} ratio={ratio()} />}
            </For>
            <Show when={d().numPages > 60}>
              <div class="tv-note">Showing the first 60 of {d().numPages} pages.</div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
