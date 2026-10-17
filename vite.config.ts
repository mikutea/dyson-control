import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:13020' } },
  build: { outDir: '../dist/web', emptyOutDir: true }
})
