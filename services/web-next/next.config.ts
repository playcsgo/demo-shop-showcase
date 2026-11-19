import type { NextConfig } from 'next'

// 客服（AIC-018）：對話框跟商店同源，/support 轉給 support-api（含 WebSocket），轉送時去掉前綴。
// 注意：rewrites 在 build 時就寫進 routes-manifest，SUPPORT_URL 要在 build 時給（Dockerfile 的 ARG），執行時改環境變數沒有用。
const supportTarget = process.env.SUPPORT_URL ?? 'http://support:3000'

const config: NextConfig = {
  output: 'standalone', // image 裡只放 server.js 和用到的 node_modules
  poweredByHeader: false,
  // socket.io 的網址是 /support/socket.io/?EIO=4…，結尾的斜線不能被 308 轉走（WEB-001 實驗）
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [{ source: '/support/:path*/', destination: `${supportTarget}/:path*/` }, // 先比對有斜線的：下一條的規則也會吃掉結尾斜線
      { source: '/support/:path*', destination: `${supportTarget}/:path*` },
    ]
  },
}

export default config
