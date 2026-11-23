/**
 * Resolves once the faces every first screen is set in (Geist, Geist Mono) are loaded —
 * or after `limit` ms, whichever comes first. Render after it.
 *
 * The faces are web fonts and load asynchronously. A page that lays text out before
 * they arrive measures it with fallbacks, and WebKit finds a fallback for "Hello" by
 * trying every family of the stack in turn — eighteen Noto script faces, none with a
 * Latin letter, each font file opened and parsed, once per weight and size: 190 files
 * and 150–250 ms of every start (strace, 2026-11-23), and then the whole page was laid
 * out again when Geist came in. The `<link rel="preload">` in each app's index.html
 * starts the download while the script is still loading, so this rarely waits at all.
 */
export function fontsReady(limit = 500): Promise<void> {
  const faces = ['1em Geist', '1em "Geist Mono"'].map((face) =>
    document.fonts.load(face).catch(() => undefined),
  )
  return Promise.race([
    Promise.all(faces).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, limit)),
  ])
}
