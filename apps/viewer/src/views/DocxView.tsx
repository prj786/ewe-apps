// Word documents through docx-preview: pages laid out like Word shows them, read-only.

import { Show, createResource, createSignal, onCleanup, type JSX } from 'solid-js'
import { formatBytes, rawUrl } from '@ewe/shared'
import { EmptyState, IconButton, Toolbar, addRecent, toast } from '@ewe/ui'
import { fileStat, openExternal } from '../lib/bridge'
import { isMod, useKeys } from '../lib/keys'
import { baseName } from '../lib/kinds'
import { getSetting, recallPosition, savePosition, setSetting } from '../lib/store'
import type { ViewProps } from './types'

const ZOOMS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200]

export function DocxView(props: ViewProps): JSX.Element {
  const [size, setSize] = createSignal(0)
  const [zoom, setZoom] = createSignal(getSetting('docxZoom', 100))
  const [pages, setPages] = createSignal(0)
  let host: HTMLDivElement | undefined
  let styles: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined

  const [state] = createResource(
    () => props.path,
    async (path) => {
      const stat = await fileStat(path)
      setSize(stat.size)
      const response = await fetch(rawUrl(props.server, path))
      if (!response.ok) throw new Error(`Could not read ${baseName(path)}`)
      const blob = await response.blob()
      const { renderAsync } = await import('docx-preview')
      if (host === undefined) return 'ready'
      host.replaceChildren()
      await renderAsync(blob, host, styles, {
        className: 'docx',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderChanges: false,
        renderComments: false,
        experimental: true,
        useBase64URL: true,
      })
      setPages(host.querySelectorAll('section.docx').length)
      void addRecent(
        path,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ).catch(() => undefined)
      const saved = await recallPosition(path)
      if (saved?.scroll !== undefined && scroller !== undefined) {
        const frac = saved.scroll
        requestAnimationFrame(() => {
          if (scroller !== undefined)
            scroller.scrollTop = frac * (scroller.scrollHeight - scroller.clientHeight)
        })
      }
      return 'ready'
    },
  )

  const stepZoom = (delta: 1 | -1) => {
    const i = ZOOMS.indexOf(zoom())
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i === -1 ? 4 : i) + delta))]
    if (next !== undefined) {
      setZoom(next)
      setSetting('docxZoom', next)
    }
  }

  const onScroll = () => {
    if (scroller === undefined) return
    const range = scroller.scrollHeight - scroller.clientHeight
    savePosition(props.path, { scroll: range <= 0 ? 0 : scroller.scrollTop / range })
  }

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (a === null) return
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault()
      void openExternal(href).catch(() => toast('Could not open the link', { kind: 'warning' }))
    } else if (!href.startsWith('#')) e.preventDefault()
  }

  useKeys(
    () => props.active,
    (e) => {
      if (!isMod(e)) return false
      if (e.key === '=' || e.key === '+') {
        stepZoom(1)
        return true
      }
      if (e.key === '-') {
        stepZoom(-1)
        return true
      }
      if (e.key === '0') {
        setZoom(100)
        setSetting('docxZoom', 100)
        return true
      }
      if (e.key === 'p') {
        window.print()
        return true
      }
      return false
    },
  )

  onCleanup(() => {
    host?.replaceChildren()
    styles?.replaceChildren()
  })

  return (
    <div class="dx">
      <Toolbar label="Document" class="view-toolbar">
        <span class="view-title">
          <span class="view-name">{baseName(props.path)}</span>
          <span class="view-meta">
            {formatBytes(size())}
            {pages() > 0 ? ` · ${pages()} ${pages() === 1 ? 'page' : 'pages'}` : ''}
          </span>
        </span>
        <span class="toolbar-spacer" />
        <IconButton icon="zoom-out" label="Zoom out (Ctrl+−)" onClick={() => stepZoom(-1)} />
        <span class="bk-font">{zoom()}%</span>
        <IconButton icon="zoom-in" label="Zoom in (Ctrl++)" onClick={() => stepZoom(1)} />
        <IconButton icon="printer" label="Print (Ctrl+P)" onClick={() => window.print()} />
      </Toolbar>
      <Show when={state.error !== undefined}>
        <div class="view-center">
          <EmptyState icon="file-text" title="Could not open this document" warning>
            {state.error instanceof Error ? state.error.message : String(state.error)}
          </EmptyState>
        </div>
      </Show>
      <div
        ref={scroller}
        class="dx-scroll print-area"
        classList={{ 'dx-scroll--loading': state.loading }}
        style={{ '--docx-zoom': zoom() / 100 }}
        onScroll={onScroll}
        onClick={onClick}
      >
        <div ref={styles} />
        <div ref={host} class="dx-host" />
      </div>
    </div>
  )
}
