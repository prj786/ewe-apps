import { Show, type JSX } from 'solid-js'
import { Icon, type IconName } from './Icon'

/** A row of controls with `--space-xs` gaps; `.toolbar-spacer` pushes the rest right. */
export function Toolbar(props: {
  label: string
  class?: string | undefined
  children: JSX.Element
}): JSX.Element {
  return (
    <div
      class={props.class === undefined ? 'toolbar' : `toolbar ${props.class}`}
      role="toolbar"
      aria-label={props.label}
    >
      {props.children}
    </div>
  )
}

/** A square icon button (`.iconbtn`) with its label as the tooltip. */
export function IconButton(props: {
  icon: IconName
  label: string
  size?: 'sm' | 'md' | 'lg' | undefined
  round?: boolean | undefined
  active?: boolean | undefined
  disabled?: boolean | undefined
  /** hide the tooltip (the label stays for screen readers) */
  quiet?: boolean | undefined
  class?: string | undefined
  onClick(e: MouseEvent): void
}): JSX.Element {
  return (
    <button
      type="button"
      class={props.class === undefined ? 'iconbtn' : `iconbtn ${props.class}`}
      classList={{
        'iconbtn--sm': props.size === 'sm',
        'iconbtn--lg': props.size === 'lg',
        'iconbtn--round': props.round ?? false,
        active: props.active ?? false,
      }}
      aria-label={props.label}
      aria-pressed={props.active}
      data-tooltip={props.quiet === true ? undefined : props.label}
      disabled={props.disabled ?? false}
      onClick={(e) => props.onClick(e)}
    >
      <Icon name={props.icon} />
    </button>
  )
}

/** A text button in the three weights of the design system. */
export function Button(props: {
  kind?: 'primary' | 'secondary' | 'ghost' | undefined
  small?: boolean | undefined
  icon?: IconName | undefined
  disabled?: boolean | undefined
  type?: 'button' | 'submit' | undefined
  class?: string | undefined
  /** tooltip / accessible name when the visible text is not enough */
  title?: string | undefined
  children: JSX.Element
  onClick?: ((e: MouseEvent) => void) | undefined
}): JSX.Element {
  return (
    <button
      type={props.type ?? 'button'}
      class={props.class === undefined ? 'btn' : `btn ${props.class}`}
      classList={{
        'btn--primary': props.kind === 'primary',
        'btn--secondary': (props.kind ?? 'secondary') === 'secondary',
        'btn--ghost': props.kind === 'ghost',
        'btn--sm': props.small ?? false,
      }}
      disabled={props.disabled ?? false}
      title={props.title}
      onClick={(e) => props.onClick?.(e)}
    >
      <Show when={props.icon}>{(icon) => <Icon name={icon()} size={14} />}</Show>
      {props.children}
    </button>
  )
}
