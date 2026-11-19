import type { MediaServer } from '@ewe/shared'

export interface ViewProps {
  path: string
  server: MediaServer
  /** the tab is the one on screen (keys, saving, animations) */
  active: boolean
  /** open another file in a new tab (links to local files, folder stepping in a new tab) */
  onOpen(path: string): void
  /** the view learned a better title (a PDF's Title, a book's) */
  onTitle?: ((title: string) => void) | undefined
  /** the view wants its tab closed (file gone, moved to Trash) */
  onClose?: (() => void) | undefined
  /** the `--key=value` flags of the command line that opened this file (lib/flags.ts) */
  flags?: readonly string[] | undefined
}

/** Zoom steps shared by the PDF, image and comic views (percent). */
export const ZOOM_STEPS = [
  25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 800,
]

export function zoomStep(current: number, delta: 1 | -1): number {
  const pct = Math.round(current * 100)
  if (delta > 0)
    return (ZOOM_STEPS.find((s) => s > pct + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 800) / 100
  const smaller = ZOOM_STEPS.filter((s) => s < pct - 0.5)
  return (smaller[smaller.length - 1] ?? ZOOM_STEPS[0] ?? 25) / 100
}

export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
