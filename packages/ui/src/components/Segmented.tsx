import { For, createEffect, on, type JSX } from 'solid-js'

export interface SegmentedOption {
  value: string
  label: string
}

export function Segmented(props: {
  value: string
  options: SegmentedOption[]
  label: string
  class?: string | undefined
  small?: boolean | undefined
  disabled?: boolean | undefined
  onChange(value: string): void
}): JSX.Element {
  let root: HTMLDivElement | undefined
  const step = (delta: number) => {
    const index = props.options.findIndex((o) => o.value === props.value)
    const next = props.options[(index + delta + props.options.length) % props.options.length]
    if (next === undefined) return
    props.onChange(next.value)
    queueMicrotask(() =>
      root?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus(),
    )
  }
  // in a narrow window the control scrolls inside itself (components.css): the chosen
  // one is brought into view, which also uncovers its neighbours, so every choice can
  // be reached with clicks alone. Only the control moves, never the page.
  createEffect(
    on(
      () => props.value,
      (value) =>
        queueMicrotask(() => {
          const el = root?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)
          if (root === undefined || el === null || el === undefined) return
          if (root.scrollWidth <= root.clientWidth) return
          const box = root.getBoundingClientRect()
          const item = el.getBoundingClientRect()
          // half of the next choice shows beside it when there is one
          const peek = item.width / 2
          if (item.left - peek < box.left) root.scrollLeft -= box.left - (item.left - peek)
          else if (item.right + peek > box.right) root.scrollLeft += item.right + peek - box.right
        }),
    ),
  )
  return (
    <div
      ref={root}
      class={props.class === undefined ? 'seg' : `seg ${props.class}`}
      classList={{ 'seg--sm': props.small ?? false }}
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1)
        else return
        e.preventDefault()
      }}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="radio"
            class="seg-item"
            classList={{ selected: option.value === props.value }}
            aria-checked={option.value === props.value}
            tabindex={option.value === props.value ? 0 : -1}
            data-value={option.value}
            disabled={props.disabled ?? false}
            onClick={() => {
              if (option.value !== props.value) props.onChange(option.value)
            }}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}
