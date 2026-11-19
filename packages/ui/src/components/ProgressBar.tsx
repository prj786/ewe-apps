import { type JSX } from 'solid-js'

/**
 * A thin bar. `value` 0–1 fills it; `null` shows the indeterminate sweep.
 * `status` tints it with a status token (copy that failed, a paused download).
 */
export function ProgressBar(props: {
  value: number | null
  label: string
  status?: 'success' | 'warning' | 'danger' | undefined
  /** `--control-sm` tall instead of a hairline, for the copy panel */
  thick?: boolean | undefined
  class?: string | undefined
}): JSX.Element {
  const percent = () => (props.value === null ? 0 : Math.min(100, Math.max(0, props.value * 100)))
  return (
    <div
      class={props.class === undefined ? 'progress' : `progress ${props.class}`}
      classList={{
        'progress--indeterminate': props.value === null,
        'progress--thick': props.thick ?? false,
        [`progress--${props.status ?? ''}`]: props.status !== undefined,
      }}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value === null ? undefined : Math.round(percent())}
    >
      <div
        class="progress-fill"
        style={props.value === null ? undefined : { width: `${percent()}%` }}
      />
    </div>
  )
}
