import { render } from 'solid-js/web'
import { invoke } from '@tauri-apps/api/core'
import { followTheme, fontsReady, installTooltips, trace } from '@ewe/ui'
import '@ewe/ui/styles.css'
import './app.css'
import { App } from './App'
import { InstallWindow } from './install'

trace('script')

// uncaught errors go to the app's stderr (nothing else shows them in a release build)
const report = (text: string) => void invoke('dev_log', { text }).catch(() => undefined)
window.addEventListener('error', (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) =>
  report(
    `unhandled: ${e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ''}` : String(e.reason)}`,
  ),
)

// the theme is on :root before the first paint; the core keeps it fresh
followTheme()
// hints (`data-tooltip`) are one bubble that stays inside the window
installTooltips()

// The small "Install" window (`--install=<card>`) is the same page with another
// view: the Rust side says so before any script runs (apps/files/src-tauri: install_shape).
const view = (window as { __eweView?: string }).__eweView
const root = document.getElementById('root')
// after the fonts: text laid out before them is measured with eighteen fallbacks first
void fontsReady().then(() => {
  trace('fonts')
  if (root !== null) render(() => (view === 'install' ? <InstallWindow /> : <App />), root)
})
