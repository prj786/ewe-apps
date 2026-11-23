import { createEffect, onCleanup } from 'solid-js'

/** Is the key going to a text field (then the view keeps its hands off)? */
export function inTextInput(e: KeyboardEvent): boolean {
  // a key re-sent from a book's iframe arrives with the Window as its target: no
  // tagName, no closest() — it threw, and no key worked while reading a book
  const t = e.target
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    t.isContentEditable ||
    // pdf.js form fields and foliate's iframe
    t.closest('.annotationLayer') !== null
  )
}

/**
 * A window keydown listener that is only attached while `active()` is true, so the
 * view in the shown tab answers and the hidden ones stay quiet. The handler returns
 * true when it used the key.
 */
export function useKeys(active: () => boolean, handler: (e: KeyboardEvent) => boolean): void {
  createEffect(() => {
    if (!active()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (handler(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })
}

export const isMod = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey
