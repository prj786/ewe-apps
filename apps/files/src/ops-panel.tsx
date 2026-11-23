// The progress panel: every running or finished operation of this window.

import { Index, Show, type JSX } from 'solid-js'
import { baseName, formatBytes, formatTimeSpan, type OpProgress } from '@ewe/shared'
import { Icon, IconButton, ProgressBar } from '@ewe/ui'

function detail(op: OpProgress): string {
  switch (op.state) {
    case 'queued':
      return 'Getting ready…'
    case 'waiting':
      return 'Waiting for your answer'
    case 'done':
      return op.totalBytes > 0
        ? `${formatBytes(op.totalBytes)} · done`
        : `${op.doneItems} item${op.doneItems === 1 ? '' : 's'} · done`
    case 'failed':
      return op.error ?? 'Failed'
    case 'cancelled':
      return 'Stopped'
    case 'paused':
    case 'running': {
      const parts: string[] = []
      if (op.totalBytes > 0)
        parts.push(`${formatBytes(op.doneBytes)} of ${formatBytes(op.totalBytes)}`)
      else if (op.totalItems > 0) parts.push(`${op.doneItems} of ${op.totalItems}`)
      if (op.state === 'paused') parts.push('paused')
      else {
        if (op.speed > 0) parts.push(`${formatBytes(op.speed)}/s`)
        if (op.eta !== null && op.eta > 0) parts.push(`${formatTimeSpan(op.eta)} left`)
      }
      return parts.join(' · ')
    }
  }
}

export function OpsPanel(props: {
  ops: OpProgress[]
  onPause(id: number): void
  onResume(id: number): void
  onCancel(id: number): void
  onDismiss(id: number): void
  onClear(): void
  onClose(): void
}): JSX.Element {
  const fraction = (op: OpProgress): number | null => {
    if (op.state === 'queued') return null
    if (op.totalBytes > 0) return op.doneBytes / op.totalBytes
    if (op.totalItems > 0) return op.doneItems / op.totalItems
    return op.state === 'done' ? 1 : null
  }
  const finished = () => props.ops.filter((o) => ['done', 'failed', 'cancelled'].includes(o.state))
  return (
    <aside class="ops" aria-label="Operations">
      <header class="ops-head">
        <span class="ops-title">Operations</span>
        <span class="toolbar-spacer" />
        <Show when={finished().length > 0}>
          <button class="btn btn--ghost btn--sm" onClick={() => props.onClear()}>
            Clear finished
          </button>
        </Show>
        <IconButton icon="x" label="Close" size="sm" onClick={() => props.onClose()} />
      </header>
      <div class="ops-list">
        {/* Index, not For: a progress event replaces the op's object ~8 times a second, and
            For rebuilt the row each time — a Pause or Stop pressed between two events
            was gone before the click landed */}
        <Index each={props.ops}>
          {(op) => (
            <div class="op" classList={{ [op().state]: true }}>
              <div class="op-row">
                <span class="op-label">{op().label}</span>
                <span class="op-actions">
                  <Show when={op().state === 'running'}>
                    <IconButton
                      icon="pause"
                      label="Pause"
                      size="sm"
                      onClick={() => props.onPause(op().id)}
                    />
                  </Show>
                  <Show when={op().state === 'paused'}>
                    <IconButton
                      icon="play"
                      label="Resume"
                      size="sm"
                      onClick={() => props.onResume(op().id)}
                    />
                  </Show>
                  <Show when={['running', 'paused', 'queued', 'waiting'].includes(op().state)}>
                    <IconButton
                      icon="x"
                      label="Stop"
                      size="sm"
                      onClick={() => props.onCancel(op().id)}
                    />
                  </Show>
                  <Show when={['done', 'failed', 'cancelled'].includes(op().state)}>
                    <IconButton
                      icon="x"
                      label="Dismiss"
                      size="sm"
                      onClick={() => props.onDismiss(op().id)}
                    />
                  </Show>
                </span>
              </div>
              <ProgressBar
                value={fraction(op())}
                label={op().label}
                status={
                  op().state === 'failed'
                    ? 'danger'
                    : op().state === 'paused' || op().state === 'waiting'
                      ? 'warning'
                      : op().state === 'done'
                        ? 'success'
                        : undefined
                }
              />
              <div class="op-detail">
                <Show when={op().state === 'failed'}>
                  <Icon name="circle-alert" size={12} />
                </Show>
                <span class="op-text">{detail(op())}</span>
                <Show
                  when={
                    op().current !== '' && (op().state === 'running' || op().state === 'paused')
                  }
                >
                  <span class="op-current">{baseName(op().current)}</span>
                </Show>
              </div>
            </div>
          )}
        </Index>
      </div>
    </aside>
  )
}
