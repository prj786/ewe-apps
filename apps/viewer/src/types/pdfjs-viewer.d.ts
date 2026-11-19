// pdfjs-dist has no `exports`/`typesVersions` map for its viewer components, so the
// deep import gets its types by hand.
declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  export * from 'pdfjs-dist/types/web/pdf_viewer.component'
}
