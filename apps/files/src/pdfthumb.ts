// pdf.js (with its worker, 1.7 MB of script) is fetched the first time a PDF needs a
// thumbnail or a look, not with the window: a folder opens without it.

/** A PNG data URL of a PDF's first page, `size` px on the long side (cached per url). */
export function pdfThumb(url: string, size: number): Promise<string | null> {
  return import('./pdfview').then(
    (m) => m.pdfThumb(url, size),
    () => null,
  )
}
