import { Show, onCleanup, onMount, type JSX } from 'solid-js'
import { Icon } from './Icon'

export interface DialogProps {
  open: boolean
  title: string
  /** one line under the title, in plain words */
  description?: string | undefined
  children?: JSX.Element
  /** the buttons; the first primary one is the default */
  actions?: JSX.Element
  /** wider card (`--panel-lg`) for lists and previews */
  wide?: boolean | undefined
  /** show the close button in the corner (default: yes) */
  closable?: boolean | undefined
  leaving?: boolean | undefined
  onClose: () => void
}

/**
 * A modal card over a scrim. Escape and a click on the scrim close it; focus
 * goes to the card on open and is kept inside with Tab.
 */
export function Dialog(props: DialogProps): JSX.Element {
  let card: HTMLDivElement | undefined

  const focusables = (): HTMLElement[] =>
    card === undefined
      ? []
      : [
          ...card.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
      return
    }
    // every other key stays in the dialog: the window's own shortcuts (next picture
    // on Space, Move to Trash on Delete…) are not for a page that is covered
    e.stopPropagation()
    if (e.key !== 'Tab') return
    const list = focusables()
    const first = list[0]
    const last = list[list.length - 1]
    if (first === undefined || last === undefined) {
      e.preventDefault()
      return
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const focusFirst = () => {
    // a field that asked for the focus keeps it (it used to go to the primary button
    // a moment later: nothing typed into Compress, Extract to or Connect landed)
    if (card?.contains(document.activeElement) === true && document.activeElement !== card) return
    const list = focusables()
    const primary = list.find((el) => el.classList.contains('btn--primary'))
    ;(primary ?? list[0] ?? card)?.focus()
  }

  onMount(() => {
    if (props.open) queueMicrotask(focusFirst)
  })

  return (
    <Show when={props.open}>
      <div
        class="dialog-scrim"
        classList={{ leaving: props.leaving ?? false }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div
          ref={(el) => {
            card = el
            queueMicrotask(focusFirst)
            onCleanup(() => {
              card = undefined
            })
          }}
          class="dialog"
          classList={{ 'dialog--wide': props.wide ?? false }}
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabindex="-1"
          onKeyDown={onKey}
        >
          <div class="dialog-head">
            <div class="dialog-heading">
              <h2 class="dialog-title">{props.title}</h2>
              <Show when={props.description}>{(text) => <p class="dialog-desc">{text()}</p>}</Show>
            </div>
            <Show when={props.closable ?? true}>
              <button
                type="button"
                class="iconbtn iconbtn--sm"
                aria-label="Close"
                onClick={() => props.onClose()}
              >
                <Icon name="x" />
              </button>
            </Show>
          </div>
          <Show when={props.children !== undefined}>
            <div class="dialog-body">{props.children}</div>
          </Show>
          <Show when={props.actions !== undefined}>
            <div class="dialog-actions">{props.actions}</div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
