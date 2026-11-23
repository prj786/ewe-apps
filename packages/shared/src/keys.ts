// Keyboard shortcuts that work on every layout.

/** What `comboKey` needs of a KeyboardEvent (so tests need no DOM). */
export interface KeyLike {
  key: string
  code: string
}

/**
 * The key a shortcut is matched against: a Latin letter in lower case when the key
 * gives one (so Caps Lock and Shift change nothing, and Dvorak keeps its own
 * letters), else — a letter key on a layout that types another script, Georgian,
 * Cyrillic, Greek… — the Latin letter printed on that key. Every other key is
 * `e.key` as it is ("ArrowLeft", "=", "F5").
 *
 * `e.key === 'c'` alone made Ctrl+C, Ctrl+V and the rest dead whenever the layout
 * was not Latin or Caps Lock was on.
 */
export function comboKey(e: KeyLike): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  // one character (not "Dead", "Enter"…) on a letter key
  if (/^.$/su.test(e.key) && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  return e.key
}
