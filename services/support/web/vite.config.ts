import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前台只認同網域的 /api 和 /socket.io：瀏覽器自動帶 HttpOnly session cookie，不需要 CORS。
// changeOrigin 關掉：後端要看到瀏覽器原本的 Origin 才能擋跨站請求
const target = process.env.API_URL ?? 'http://support:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // xfwd：把瀏覽器的位址放進 X-Forwarded-For，後端才能按來源限流（只信任這個代理）
      '/api': { target, changeOrigin: false, xfwd: true },
      '/socket.io': { target, changeOrigin: false, ws: true, xfwd: true },
    },
  },
})
