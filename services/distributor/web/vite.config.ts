import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前台只認同網域的 /api：瀏覽器自動帶 HttpOnly session cookie，不需要 CORS，也不用經過 BFF
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://distributor-nginx', changeOrigin: false } },
  },
})
