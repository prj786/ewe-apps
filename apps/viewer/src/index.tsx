import { render } from 'solid-js/web'
import { followTheme } from '@ewe/ui'
import '@ewe/ui/styles.css'
import './app.css'
import { App } from './App'

// the theme is on :root before the first paint; the core keeps it fresh
followTheme()

const root = document.getElementById('root')
if (root !== null) render(() => <App />, root)
