import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 开发期 Vite dev server 把 /ws 代理到本地 daemon
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:9800',
        ws: true,
      },
    },
  },
})
