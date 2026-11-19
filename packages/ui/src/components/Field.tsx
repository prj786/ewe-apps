import { Show, type JSX } from 'solid-js'
import { Icon, type IconName } from './Icon'

/**
 * A single-line text input in a bordered well, with an optional leading glyph
 * and a clear button. `onSubmit` fires on Enter, `onCancel` on Escape.
 */
export function Field(props: {
  value: string
  label: string
  placeholder?: string | undefined
  icon?: IconName | undefined
  mono?: boolean | undefined
  small?: boolean | undefined
  disabled?: boolean | undefined
  clearable?: boolean | undefined
  autofocus?: boolean | undefined
  class?: string | undefined
  ref?: ((el: HTMLInputElement) => void) | undefined
  onInput(value: string): void
  onSubmit?: ((value: string) => void) | undefined
  onCancel?: (() => void) | undefined
  onBlur?: (() => void) | undefined
}): JSX.Element {
  return (
    <label
      class={props.class === undefined ? 'field' : `field ${props.class}`}
      classList={{ 'field--sm': props.small ?? false, 'field--mono': props.mono ?? false }}
    >
      <Show when={props.icon}>
        {(icon) => (
          <span class="field-icon">
            <Icon name={icon()} />
          </span>
        )}
      </Show>
      <input
        ref={(el) => {
          props.ref?.(el)
          if (props.autofocus === true) queueMicrotask(() => el.focus())
        }}
        class="field-input"
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        disabled={props.disabled ?? false}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={() => props.onBlur?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSubmit?.(e.currentTarget.value)
          else if (e.key === 'Escape') props.onCancel?.()
          else return
          e.preventDefault()
        }}
      />
      <Show when={props.clearable === true && props.value !== ''}>
        <button
          type="button"
          class="field-clear"
          aria-label="Clear"
          tabindex="-1"
          onClick={() => props.onInput('')}
        >
          <Icon name="x" size={12} />
        </button>
      </Show>
    </label>
  )
}
