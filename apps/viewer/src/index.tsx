import { render } from 'solid-js/web'
import { followTheme, fontsReady, trace } from '@ewe/ui'
import '@ewe/ui/styles.css'
// pdf.js' component styles come before app.css so the kit's .dialog / .page win
import 'pdfjs-dist/web/pdf_viewer.css'
import './app.css'
import { App } from './App'
import { forwardErrors } from './lib/debug'

trace('script')

// the theme is on :root before the first paint; the core keeps it fresh
followTheme()
forwardErrors()

const root = document.getElementById('root')
// after the fonts: text laid out before them is measured with eighteen fallbacks first
void fontsReady().then(() => {
  trace('fonts')
  if (root !== null) render(() => <App />, root)
})
