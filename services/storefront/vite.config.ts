import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前台只認同網域的 /api（由 BFF 處理）→ 瀏覽器帶 httpOnly cookie，不需要 CORS、不需要 token
// 客服（AIC-018）：對話框跟商店同源，/support 轉給 support-api（含 WebSocket），轉送時去掉前綴。
// support 沒開時 proxy 會失敗，對話框收到錯誤就顯示「客服暫時無法使用」，商店其他功能不受影響
const supportTarget = process.env.SUPPORT_URL ?? 'http://support:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: process.env.BFF_URL ?? 'http://bff-gateway:3000', changeOrigin: false },
      // changeOrigin 關掉：support-api 要看到瀏覽器原本的 Origin 才能擋跨站請求
      '/support': { target: supportTarget, changeOrigin: false, ws: true, xfwd: true, rewrite: (path) => path.replace(/^\/support/, '') },
    },
  },
})
