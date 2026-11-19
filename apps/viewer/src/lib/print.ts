// Printing a PDF: pdf.js only draws the pages on screen, so every page is rendered
// into an image inside #print-pages (shown by @media print only) before window.print()
// opens the GTK dialog. 150 dpi keeps 200 pages within reason.

import type { PDFDocumentProxy } from 'pdfjs-dist'

const PRINT_DPI = 150

export interface PrintJob {
  /** resolves true when every page is in place, false when cancelled */
  ready: Promise<boolean>
  cancel(): void
  /** remove the images again (after printing) */
  cleanup(): void
}

function printRoot(): HTMLDivElement {
  let root = document.getElementById('print-pages') as HTMLDivElement | null
  if (root === null) {
    root = document.createElement('div')
    root.id = 'print-pages'
    document.body.append(root)
  }
  return root
}

export function printPages(
  doc: PDFDocumentProxy,
  rotation: number,
  onProgress: (done: number, total: number) => void,
): PrintJob {
  let cancelled = false
  const root = printRoot()
  root.replaceChildren()
  const urls: string[] = []

  const ready = (async () => {
    const total = doc.numPages
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { alpha: false })
    if (ctx === null) throw new Error('no canvas')
    for (let n = 1; n <= total; n++) {
      if (cancelled) return false
      const page = await doc.getPage(n)
      const viewport = page.getViewport({
        scale: PRINT_DPI / 72,
        rotation: (page.rotate + rotation) % 360,
      })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, viewport, intent: 'print', annotationMode: 2 }).promise
      if (cancelled) return false
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (blob === null) throw new Error('could not render page')
      const url = URL.createObjectURL(blob)
      urls.push(url)
      const sheet = document.createElement('div')
      sheet.className = 'print-sheet'
      sheet.classList.toggle('landscape', viewport.width > viewport.height)
      const img = document.createElement('img')
      img.src = url
      img.alt = `Page ${n}`
      sheet.append(img)
      root.append(sheet)
      onProgress(n, total)
    }
    canvas.width = canvas.height = 0
    return true
  })()

  return {
    ready,
    cancel: () => {
      cancelled = true
    },
    cleanup: () => {
      const clear = () => {
        root.replaceChildren()
        for (const u of urls) URL.revokeObjectURL(u)
      }
      // the print dialog may still be reading the images
      const once = () => {
        window.removeEventListener('afterprint', once)
        clear()
      }
      window.addEventListener('afterprint', once)
      setTimeout(once, 120_000)
    },
  }
}
