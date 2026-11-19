import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Plain Vite + Solid; the Tauri CLI runs `dev` / `build` through tauri.conf.json.
export default defineConfig({
  plugins: [solid()],
  resolve: { dedupe: ['solid-js'] },
  clearScreen: false,
  server: {
    port: 5182,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebKitGTK 2.54 (Arch, 2026): modern JS and CSS, no polyfills
    target: 'safari18',
    minify: true,
    sourcemap: false,
  },
})
