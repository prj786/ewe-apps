// The start screen: open a file, drop one in, or pick up a recent document (with a
// thumbnail: the core's cache for pictures, pdf.js' first page for PDFs).

import { For, Show, createResource, createSignal, type JSX } from 'solid-js'
import { formatBytes, rawUrl, thumbUrl, timeAgo, type MediaServer } from '@ewe/shared'
import { Button, EmptyState, Icon } from '@ewe/ui'
import { recentDocuments, type RecentDoc } from '../lib/bridge'
import { KIND_ICON, KIND_LABEL, docKind } from '../lib/kinds'
import { DOCUMENT_OPTIONS, loadPdfJs } from '../lib/pdfjs'

const pdfThumbs = new Map<string, Promise<string | null>>()

async function renderPdfThumb(url: string, width: number): Promise<string | null> {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS, disableAutoFetch: true })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const ratio = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: (width * ratio) / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    return canvas.toDataURL('image/png')
  } catch {
    return null
  } finally {
    void task.destroy()
  }
}

function pdfThumb(server: MediaServer, path: string): Promise<string | null> {
  const key = path
  let job = pdfThumbs.get(key)
  if (job === undefined) {
    job = renderPdfThumb(rawUrl(server, path), 160)
    pdfThumbs.set(key, job)
  }
  return job
}

function Thumb(props: { doc: RecentDoc; server: MediaServer }): JSX.Element {
  const kind = () => docKind(props.doc.path)
  const [pdfSrc] = createResource(
    () => (kind() === 'pdf' ? props.doc.path : null),
    (path) => pdfThumb(props.server, path),
  )
  const [failed, setFailed] = createSignal(false)
  return (
    <span class="start-thumb" classList={{ [`start-thumb--${kind()}`]: true }}>
      <Show
        when={
          !failed() &&
          (kind() === 'image' || (kind() === 'pdf' && pdfSrc() !== null && pdfSrc() !== undefined))
        }
        fallback={<Icon name={KIND_ICON[kind()]} size={28} />}
      >
        <img
          src={kind() === 'image' ? thumbUrl(props.server, props.doc.path, 256) : (pdfSrc() ?? '')}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      </Show>
    </span>
  )
}

export function Start(props: {
  server: MediaServer
  refresh: number
  onOpen(path: string): void
  onBrowse(): void
}): JSX.Element {
  const [recents] = createResource(
    () => props.refresh,
    () => recentDocuments(24).catch((): RecentDoc[] => []),
  )

  return (
    <div class="start">
      <div class="start-hero">
        <EmptyState icon="book-open" title="Open a document" heading="h2">
          PDFs, books, comics, pictures, Markdown, text, Word documents and spreadsheets open in
          tabs. Drop files here, or press Ctrl+O.
        </EmptyState>
        <div class="empty-actions">
          <Button kind="primary" icon="folder-open" onClick={() => props.onBrowse()}>
            Open…
          </Button>
        </div>
      </div>
      <Show when={(recents() ?? []).length > 0}>
        <section class="start-recent" aria-label="Recent documents">
          <h3 class="start-heading">Recent</h3>
          <ul class="start-grid">
            <For each={recents() ?? []}>
              {(doc) => (
                <li>
                  <button
                    type="button"
                    class="start-card"
                    title={doc.path}
                    onClick={() => props.onOpen(doc.path)}
                  >
                    <Thumb doc={doc} server={props.server} />
                    <span class="start-card-name">{doc.name}</span>
                    <span class="start-card-meta">
                      {KIND_LABEL[docKind(doc.path)]} · {formatBytes(doc.size)}
                      {doc.opened > 0 ? ` · ${timeAgo(doc.opened)}` : ''}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  )
}
