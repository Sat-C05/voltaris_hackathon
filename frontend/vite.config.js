import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build straight into backend/static so the demo is ONE process to start and restart.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../backend/static', emptyOutDir: true },
  server: { proxy: { '/world': 'http://127.0.0.1:8000', '/events': 'http://127.0.0.1:8000', '/incidents': 'http://127.0.0.1:8000', '/stations': 'http://127.0.0.1:8000', '/evaluation': 'http://127.0.0.1:8000', '/clock': 'http://127.0.0.1:8000', '/runs': 'http://127.0.0.1:8000', '/faults': 'http://127.0.0.1:8000', '/scenarios': 'http://127.0.0.1:8000', '/health': 'http://127.0.0.1:8000' } },
})
