import { render } from 'solid-js/web'
import { followTheme, fontsReady, trace } from '@ewe/ui'
import '@ewe/ui/styles.css'
import './app.css'
import { App } from './App'

// the theme is on :root before the first paint; the core keeps it fresh
followTheme()

trace('script')

const root = document.getElementById('root')
// after the fonts: text laid out before them is measured with eighteen fallbacks first
void fontsReady().then(() => {
  trace('fonts')
  if (root !== null) render(() => <App />, root)
})
