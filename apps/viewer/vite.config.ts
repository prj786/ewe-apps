import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
// what pdf.js fetches at run time, served under /pdfjs/ (lib/pdfjs.ts points there)
const PDFJS_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs']

/** Copy pdf.js' run-time assets into dist/pdfjs (build) and serve them in dev. */
function pdfjsAssets(): Plugin {
  const types: Record<string, string> = {
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/x-font-type1',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.icc': 'application/vnd.iccprofile',
    '.js': 'text/javascript',
  }
  return {
    name: 'ewe-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/pdfjs/')) return next()
        const rel = decodeURIComponent(url.slice('/pdfjs/'.length).split('?')[0] ?? '')
        if (rel.includes('..') || !PDFJS_DIRS.some((d) => rel.startsWith(`${d}/`))) return next()
        const file = join(pdfjsRoot, rel)
        if (!existsSync(file)) return next()
        const ext = rel.slice(rel.lastIndexOf('.'))
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    closeBundle() {
      const out = join(import.meta.dirname, 'dist', 'pdfjs')
      mkdirSync(out, { recursive: true })
      for (const dir of PDFJS_DIRS)
        cpSync(join(pdfjsRoot, dir), join(out, dir), { recursive: true })
    },
  }
}

// Plain Vite + Solid; the Tauri CLI runs `dev` / `build` through tauri.conf.json.
export default defineConfig({
  plugins: [solid(), pdfjsAssets()],
  resolve: { dedupe: ['solid-js'] },
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebKitGTK 2.54 (Arch, 2026): modern JS and CSS, no polyfills
    target: 'safari18',
    minify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
})
