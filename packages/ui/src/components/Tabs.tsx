import { For, Show, createEffect, on, type JSX } from 'solid-js'
import { Icon, type IconName } from './Icon'

export interface TabItem {
  id: string
  label: string
  icon?: IconName | undefined
  /** a hint shown as the tooltip, e.g. the full path */
  hint?: string | undefined
  /** a small dot after the label (unsaved, playing) */
  dot?: boolean | undefined
}

/**
 * A tab strip (`role=tablist`): click selects, middle-click closes, arrows
 * move, Delete closes the selected one. A trailing + button adds a tab when
 * `onAdd` is given.
 */
export function Tabs(props: {
  tabs: TabItem[]
  selected: string
  label: string
  class?: string | undefined
  onSelect(id: string): void
  onClose?: ((id: string) => void) | undefined
  onAdd?: (() => void) | undefined
  /** right-click on a tab */
  onMenu?: ((id: string, at: { x: number; y: number }) => void) | undefined
}): JSX.Element {
  let root: HTMLDivElement | undefined

  const step = (delta: number) => {
    const i = props.tabs.findIndex((t) => t.id === props.selected)
    const n = props.tabs.length
    if (n === 0) return
    const next = props.tabs[(i + delta + n) % n]
    if (next === undefined) return
    props.onSelect(next.id)
    queueMicrotask(() =>
      root?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus(),
    )
  }

  // a strip that scrolls (narrow windows) keeps the selected tab in view; only the strip
  // moves, never the page
  createEffect(
    on(
      () => [props.selected, props.tabs.length] as const,
      ([id]) =>
        queueMicrotask(() => {
          const el = root?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)
          if (root === undefined || el === null || el === undefined) return
          const strip = root.getBoundingClientRect()
          const tab = el.getBoundingClientRect()
          if (tab.left < strip.left) root.scrollLeft -= strip.left - tab.left
          else if (tab.right > strip.right) root.scrollLeft += tab.right - strip.right
        }),
    ),
  )

  return (
    <div
      ref={root}
      class={props.class === undefined ? 'tabs' : `tabs ${props.class}`}
      role="tablist"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') step(1)
        else if (e.key === 'ArrowLeft') step(-1)
        else if (e.key === 'Delete' && props.onClose !== undefined) props.onClose(props.selected)
        else return
        e.preventDefault()
      }}
    >
      <For each={props.tabs}>
        {(tab) => (
          <div
            class="tab"
            classList={{ selected: tab.id === props.selected }}
            role="tab"
            aria-selected={tab.id === props.selected}
            tabindex={tab.id === props.selected ? 0 : -1}
            data-tab={tab.id}
            title={tab.hint}
            // a click selects the tab but leaves the keyboard with the document:
            // focus on the strip gave it ←/→ and Delete (the next picture switched
            // tabs, Delete closed one)
            onMouseDown={(e) => {
              if (e.button === 0) e.preventDefault()
            }}
            onClick={() => props.onSelect(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) props.onClose?.(tab.id)
            }}
            onContextMenu={(e) => {
              if (props.onMenu === undefined) return
              e.preventDefault()
              props.onMenu(tab.id, { x: e.clientX, y: e.clientY })
            }}
          >
            <Show when={tab.icon}>{(icon) => <Icon name={icon()} size={14} />}</Show>
            <span class="tab-label" dir="auto">
              {tab.label}
            </span>
            <Show when={tab.dot}>
              <span class="tab-dot" />
            </Show>
            <Show when={props.onClose !== undefined}>
              <button
                type="button"
                class="tab-close"
                aria-label={`Close ${tab.label}`}
                tabindex="-1"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onClose?.(tab.id)
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </Show>
          </div>
        )}
      </For>
      <Show when={props.onAdd !== undefined}>
        <button
          type="button"
          class="iconbtn iconbtn--sm tabs-add"
          aria-label="New tab"
          onClick={() => props.onAdd?.()}
        >
          <Icon name="plus" />
        </button>
      </Show>
    </div>
  )
}
