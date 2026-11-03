import { defineConfig } from 'vite'

// The Tauri shell's Node host (src/host/main.ts) as one file, out/host/main.mjs. Packages stay
// outside the bundle (node-pty is native, the rest load from node_modules), as electron-vite
// does for the Electron main process.
export default defineConfig({
  build: {
    ssr: 'src/host/main.ts',
    outDir: 'out/host',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'main.mjs' } },
  },
})
