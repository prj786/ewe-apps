// pdf.js, loaded once: the worker is bundled by Vite (served from 'self', so the CSP
// needs no remote scripts); the standard fonts, CMaps and wasm decoders are copied
// next to the bundle by the plugin in vite.config.ts (/pdfjs/…).

import type * as PdfJsModule from 'pdfjs-dist'
import type * as PdfViewerNs from 'pdfjs-dist/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export type PdfJs = typeof PdfJsModule
export type PdfViewerModule = typeof PdfViewerNs

let library: Promise<PdfJs> | null = null
let viewer: Promise<PdfViewerModule> | null = null

export function loadPdfJs(): Promise<PdfJs> {
  library ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    return pdfjs
  })
  return library
}

/** The viewer components read the library from `globalThis.pdfjsLib`, so it loads first. */
export function loadPdfViewer(): Promise<PdfViewerModule> {
  viewer ??= loadPdfJs().then((pdfjs) => {
    const g = globalThis as { pdfjsLib?: unknown }
    g.pdfjsLib ??= pdfjs
    return import('pdfjs-dist/web/pdf_viewer.mjs')
  })
  return viewer
}

const base = new URL('/pdfjs/', document.baseURI).href

/** Options every getDocument() call shares. */
export const DOCUMENT_OPTIONS = {
  cMapUrl: `${base}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}standard_fonts/`,
  wasmUrl: `${base}wasm/`,
  iccUrl: `${base}iccs/`,
  isEvalSupported: false,
  enableXfa: true,
}
