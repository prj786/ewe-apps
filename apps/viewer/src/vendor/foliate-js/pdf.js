// ewe Viewer shows PDFs with pdf.js directly (views/PdfView.tsx); foliate-js
// only imports this lazily for a .pdf handed to view.open(), which never happens.
export const makePDF = async () => {
  throw new Error('PDF is not handled by foliate-js here')
}
