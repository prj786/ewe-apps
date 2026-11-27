import { type JSX } from 'solid-js'

/**
 * A plain-words hint on hover and keyboard focus. Wraps its child in an inline
 * box carrying `data-tooltip`; the bubble itself is one element for the whole
 * window, placed inside it by `installTooltips` and shown after `--tooltip-delay`.
 */
export function Tooltip(props: {
  text: string
  /** put the bubble under the child instead of above */
  below?: boolean | undefined
  class?: string | undefined
  children: JSX.Element
}): JSX.Element {
  return (
    <span
      class={props.class === undefined ? 'tip' : `tip ${props.class}`}
      classList={{ 'tip--below': props.below ?? false }}
      data-tooltip={props.text}
    >
      {props.children}
    </span>
  )
}
