// The preview pane (F9): the selected file at a glance.

import { Match, Show, Switch, createResource, type JSX } from 'solid-js'
import { fileKind, formatBytes, type FsEntry, type ThumbSize } from '@ewe/shared'
import { Button, EmptyState, Icon } from '@ewe/ui'
import { api } from './api'
import { fmtDate } from './dialogs'
import { KIND_ICON, KIND_LABEL, type Row } from './pane'
import { pdfThumb } from './pdfview'

export function Preview(props: {
  row: Row | null
  rawUrl(path: string): string
  thumbUrl(path: string, size: ThumbSize): string
  onOpen(row: FsEntry): void
}): JSX.Element {
  const kind = () => (props.row === null ? 'other' : fileKind(props.row))
  const [mime] = createResource(
    () => props.row?.path ?? null,
    (p) => api.mimeOf(p),
  )
  const [pdf] = createResource(
    () => (props.row !== null && kind() === 'pdf' ? props.rawUrl(props.row.path) : null),
    (url) => pdfThumb(url, 512),
  )
  const [text] = createResource(
    () =>
      props.row !== null && (kind() === 'text' || kind() === 'code') && props.row.size < 200_000
        ? props.rawUrl(props.row.path)
        : null,
    async (url) => {
      const r = await fetch(url, { headers: { range: 'bytes=0-4095' } })
      return r.ok ? (await r.text()).split('\n').slice(0, 40).join('\n') : ''
    },
  )
  return (
    <aside class="fm-preview" aria-label="Preview">
      <Show
        when={props.row}
        fallback={
          <EmptyState icon="eye" title="Nothing selected" compact>
            Select one file to see it here.
          </EmptyState>
        }
      >
        {(row) => (
          <>
            <div class="fm-preview-stage">
              <Switch
                fallback={
                  <span
                    class={`fm-icon kind-${kind()} fm-preview-icon`}
                    classList={{ folder: row().dir }}
                  >
                    <Icon name={KIND_ICON[kind()]} size={56} />
                  </span>
                }
              >
                <Match when={kind() === 'image'}>
                  <img class="fm-preview-img" src={props.rawUrl(row().path)} alt="" />
                </Match>
                <Match when={kind() === 'video' || kind() === 'audio'}>
                  <img class="fm-preview-img" src={props.thumbUrl(row().path, 512)} alt="" />
                </Match>
                <Match when={kind() === 'pdf' && pdf()}>
                  {(url) => <img class="fm-preview-img paper" src={url()} alt="" />}
                </Match>
                <Match when={(kind() === 'text' || kind() === 'code') && text()}>
                  {(t) => <pre class="fm-preview-text">{t()}</pre>}
                </Match>
              </Switch>
            </div>
            <div class="fm-preview-name">{row().name}</div>
            <dl class="props-grid compact">
              <dt>Type</dt>
              <dd>{mime()?.description ?? KIND_LABEL[kind()]}</dd>
              <Show when={!row().dir}>
                <dt>Size</dt>
                <dd>{formatBytes(row().size)}</dd>
              </Show>
              <dt>Modified</dt>
              <dd>{fmtDate(row().mtime)}</dd>
            </dl>
            <Show when={!row().dir}>
              <Button small icon="external-link" onClick={() => props.onOpen(row())}>
                Open
              </Button>
            </Show>
          </>
        )}
      </Show>
    </aside>
  )
}
