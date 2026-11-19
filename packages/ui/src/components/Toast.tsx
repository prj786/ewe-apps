import { For, Show, createSignal, type JSX } from 'solid-js'
import { Icon, type IconName } from './Icon'

export type ToastKind = 'info' | 'success' | 'warning' | 'danger'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  /** an optional button, e.g. Undo */
  action?: { label: string; run: () => void } | undefined
  /** ms before it goes away; 0 keeps it until dismissed */
  duration: number
}

const ICON: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  danger: 'circle-alert',
}

const [items, setItems] = createSignal<ToastItem[]>([])
let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
  setItems((list) => list.filter((t) => t.id !== id))
}

/** Show a toast at the bottom of the window. Returns its id. */
export function toast(
  text: string,
  options: { kind?: ToastKind; action?: ToastItem['action']; duration?: number } = {},
): number {
  const id = nextId++
  const item: ToastItem = {
    id,
    kind: options.kind ?? 'info',
    text,
    action: options.action,
    duration: options.duration ?? (options.action === undefined ? 4000 : 8000),
  }
  setItems((list) => [...list.slice(-3), item])
  if (item.duration > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), item.duration),
    )
  return id
}

/** Mount once near the app root. */
export function Toasts(): JSX.Element {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={items()}>
        {(item) => (
          <div class="toast" classList={{ [`toast--${item.kind}`]: true }}>
            <span class="toast-icon">
              <Icon name={ICON[item.kind]} />
            </span>
            <span class="toast-text">{item.text}</span>
            <Show when={item.action}>
              {(action) => (
                <button
                  type="button"
                  class="btn btn--sm btn--ghost toast-action"
                  onClick={() => {
                    action().run()
                    dismissToast(item.id)
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="iconbtn iconbtn--sm"
              aria-label="Dismiss"
              onClick={() => dismissToast(item.id)}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
