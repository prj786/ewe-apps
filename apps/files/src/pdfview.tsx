// PDFs through pdf.js: first-page thumbnails for tiles and a page-by-page quick look.

import { For, Show, createResource, createSignal, onCleanup, type JSX } from 'solid-js'
import * as pdfjs from 'pdfjs-dist'
// The worker module in the main bundle: WebKitGTK refuses a module worker from the
// tauri:// scheme ("Load failed"), and pdf.js uses globalThis.pdfjsWorker when it
// is already there, so parsing runs on this thread. Fine for thumbnails and a look.
import 'pdfjs-dist/build/pdf.worker.min.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const thumbs = new Map<string, Promise<string | null>>()
const MAX_CACHED = 400

/** A PNG data URL of the first page, `size` px on the long side (cached per url). */
export function pdfThumb(url: string, size: number): Promise<string | null> {
  const key = `${size}:${url}`
  const cached = thumbs.get(key)
  if (cached !== undefined) return cached
  const job = (async () => {
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
  })()
  if (thumbs.size >= MAX_CACHED) thumbs.clear()
  thumbs.set(key, job)
  return job
}

function Page(props: { doc: PDFDocumentProxy; index: number; width: number }): JSX.Element {
  let canvas: HTMLCanvasElement | undefined
  let cancelled = false
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
      ref={(el) => {
        canvas = el
        void draw(el)
      }}
      aria-label={`Page ${props.index}`}
    />
  )
}

/** Continuous pages at the stage width; up to 60 pages are drawn. */
export function PdfView(props: { url: string; name: string }): JSX.Element {
  const [width, setWidth] = createSignal(720)
  const [doc] = createResource(
    () => props.url,
    async (url) => {
      const task = pdfjs.getDocument({ url })
      const d = await task.promise
      onCleanup(() => void task.destroy())
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
            <For each={pages()}>{(i) => <Page doc={d()} index={i} width={width()} />}</For>
            <Show when={d().numPages > 60}>
              <div class="tv-note">Showing the first 60 of {d().numPages} pages.</div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
