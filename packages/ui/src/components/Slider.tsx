import { type JSX } from 'solid-js'

/**
 * A horizontal range control (volume, seek, zoom). The filled part follows the
 * value through `--slider-fill`; arrow keys step, Home/End jump.
 */
export function Slider(props: {
  value: number
  min?: number | undefined
  max?: number | undefined
  step?: number | undefined
  label: string
  class?: string | undefined
  disabled?: boolean | undefined
  /** called while dragging */
  onInput(value: number): void
  /** called once the pointer lets go */
  onChange?: ((value: number) => void) | undefined
}): JSX.Element {
  const min = () => props.min ?? 0
  const max = () => props.max ?? 100
  const fill = () => {
    const span = max() - min()
    if (span <= 0) return 0
    return Math.min(100, Math.max(0, ((props.value - min()) / span) * 100))
  }
  return (
    <input
      type="range"
      class={props.class === undefined ? 'slider' : `slider ${props.class}`}
      style={{ '--slider-fill': `${fill()}%` }}
      min={min()}
      max={max()}
      step={props.step ?? 1}
      value={props.value}
      aria-label={props.label}
      aria-valuetext={String(props.value)}
      disabled={props.disabled ?? false}
      onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      onChange={(e) => props.onChange?.(Number(e.currentTarget.value))}
    />
  )
}
