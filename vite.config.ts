import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the built app works when loaded via file:// in the
  // packaged Electron app (absolute '/assets/...' paths resolve to the drive root).
  base: './',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
