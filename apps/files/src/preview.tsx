// The preview pane (F9): the selected file at a glance.

import { Match, Show, Switch, createResource, type JSX } from 'solid-js'
import { fileKind, formatBytes, type FsEntry, type TextFile, type ThumbSize } from '@ewe/shared'
import { Button, EmptyState, Icon, IconButton } from '@ewe/ui'
import { api } from './api'
import { fmtDate } from './dialogs'
import { KIND_ICON, KIND_LABEL, type Row } from './pane'
import { pdfThumb } from './pdfview'

export function Preview(props: {
  row: Row | null
  rawUrl(path: string): string
  /** pictures: HEIC/HEIF come converted */
  pictureUrl(path: string): string
  /** text decoded by the core, whatever its encoding */
  readText(path: string, max?: number): Promise<TextFile>
  thumbUrl(path: string, size: ThumbSize): string
  onOpen(row: FsEntry): void
  /** compact windows: the pane floats over the folder and has a close button */
  overlay?: boolean | undefined
  onClose?: (() => void) | undefined
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
        ? props.row.path
        : null,
    async (path) => {
      try {
        const read = await props.readText(path, 4096)
        return read.text.split('\n').slice(0, 40).join('\n')
      } catch {
        return ''
      }
    },
  )
  return (
    <aside class="fm-preview" classList={{ overlay: props.overlay ?? false }} aria-label="Preview">
      <Show when={props.overlay === true && props.onClose}>
        {(close) => (
          <IconButton
            icon="x"
            label="Close the preview (F9)"
            size="sm"
            class="fm-preview-close"
            onClick={() => close()()}
          />
        )}
      </Show>
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
                  <img class="fm-preview-img" src={props.pictureUrl(row().path)} alt="" />
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
            <div class="fm-preview-name" dir="auto">
              {row().name}
            </div>
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
