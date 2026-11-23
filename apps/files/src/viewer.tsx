// Quick look (Space / Enter on media): images, video, audio, text, code, Markdown
// and PDF over the folder, stepping through the folder's viewable files.

import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { fileKind, formatBytes, type FsEntry, type TextFile } from '@ewe/shared'
import { Icon, IconButton } from '@ewe/ui'

// pdf.js, highlight.js, marked and DOMPurify are 1.7 MB of script that only a look at a
// PDF or a text file needs: each comes with its first use, not with every window.
const PdfView = lazy(() => import('./pdfview').then((m) => ({ default: m.PdfView })))
const TextView = lazy(() => import('./textview').then((m) => ({ default: m.TextView })))

export interface ViewerProps {
  items: FsEntry[]
  index: number
  rawUrl: (path: string) => string
  /** pictures: HEIC/HEIF come converted */
  pictureUrl: (path: string) => string
  readText: (path: string, max?: number) => Promise<TextFile>
  onIndex: (index: number) => void
  onClose: () => void
  onExternal: (entry: FsEntry) => void
  onLink: (href: string) => void
}

export function Viewer(props: ViewerProps): JSX.Element {
  const [actual, setActual] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const entry = () => props.items[props.index]
  const count = () => props.items.length
  const kind = () => {
    const e = entry()
    return e === undefined ? 'other' : fileKind(e)
  }

  createEffect(
    on(
      () => entry()?.path,
      () => {
        setActual(false)
        setFailed(false)
      },
    ),
  )

  const step = (delta: number) => {
    if (count() < 2) return
    props.onIndex((props.index + delta + count()) % count())
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') props.onClose()
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1)
      else if (e.key === 'Home') props.onIndex(0)
      else if (e.key === 'End') props.onIndex(count() - 1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => window.removeEventListener('keydown', onKey, true))
  })

  const preload = () => {
    for (const delta of [1, -1]) {
      const next = props.items[(props.index + delta + count()) % count()]
      if (next !== undefined && fileKind(next) === 'image') {
        const img = new Image()
        img.src = props.pictureUrl(next.path)
      }
    }
  }

  return (
    <Show when={entry()}>
      {(current) => (
        <div class="mv" role="dialog" aria-label={current().name}>
          <header class="mv-top">
            <span class="mv-title">
              <span class="mv-name" dir="auto">
                {current().name}
              </span>
              <span class="mv-meta">
                {count() > 1 ? `${props.index + 1} of ${count()} · ` : ''}
                {formatBytes(current().size)}
              </span>
            </span>
            <IconButton
              icon="external-link"
              label="Open with the default app"
              onClick={() => props.onExternal(current())}
            />
            <IconButton icon="x" label="Close (Esc)" onClick={() => props.onClose()} />
          </header>
          <div
            class="mv-stage"
            classList={{
              actual: actual(),
              doc: kind() === 'pdf' || kind() === 'text' || kind() === 'code',
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) props.onClose()
            }}
          >
            <Show
              when={!failed()}
              fallback={
                <div class="mv-failed">
                  <Icon name="circle-alert" size={32} />
                  <span>This file cannot be shown here.</span>
                  <button
                    class="btn btn--secondary btn--sm"
                    onClick={() => props.onExternal(current())}
                  >
                    Open with the default app
                  </button>
                </div>
              }
            >
              <Switch>
                <Match when={kind() === 'image'}>
                  <img
                    class="mv-image"
                    src={props.pictureUrl(current().path)}
                    alt={current().name}
                    draggable={false}
                    onLoad={preload}
                    onError={() => setFailed(true)}
                    onClick={() => setActual((a) => !a)}
                  />
                </Match>
                <Match when={kind() === 'video'}>
                  <video
                    class="mv-video"
                    src={props.rawUrl(current().path)}
                    controls
                    autoplay
                    onError={() => setFailed(true)}
                  />
                </Match>
                <Match when={kind() === 'pdf'}>
                  <PdfView url={props.rawUrl(current().path)} name={current().name} />
                </Match>
                <Match when={kind() === 'text' || kind() === 'code'}>
                  <TextView
                    entry={current()}
                    rawUrl={props.rawUrl}
                    readText={props.readText}
                    onLink={props.onLink}
                  />
                </Match>
                <Match when={kind() === 'audio'}>
                  <div class="mv-audio">
                    <span class="mv-audio-art">
                      <Icon name="music" size={48} />
                    </span>
                    <span class="mv-audio-name" dir="auto">
                      {current().name}
                    </span>
                    <audio
                      src={props.rawUrl(current().path)}
                      controls
                      autoplay
                      onError={() => setFailed(true)}
                      onEnded={() => step(1)}
                    />
                  </div>
                </Match>
              </Switch>
            </Show>
          </div>
          <Show when={count() > 1}>
            <button class="mv-nav prev" aria-label="Previous" onClick={() => step(-1)}>
              <Icon name="chevron-left" size={24} />
            </button>
            <button class="mv-nav next" aria-label="Next" onClick={() => step(1)}>
              <Icon name="chevron-right" size={24} />
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
