/**
 * `--shot-width=<px>` / `--shot-height=<px>` (scripts/shot.sh): size the app root like a
 * smaller window inside cage's fixed 1280×720 output. The kit's CSS (`:root[data-shot] .app`)
 * applies the size and keeps dialogs, menus and toasts inside the root, and the `app`
 * container queries answer to that size, so a narrow shot looks like a narrow window.
 */
export function applyShotSize(flags: readonly string[]): void {
  const root = document.documentElement
  for (const axis of ['width', 'height'] as const) {
    const prefix = `--shot-${axis}=`
    const flag = flags.find((f) => f.startsWith(prefix))
    if (flag === undefined) continue
    const px = Number(flag.slice(prefix.length))
    if (!Number.isFinite(px) || px <= 0) continue
    root.style.setProperty(`--shot-${axis}`, `${px}px`)
    root.dataset.shot = ''
  }
}
