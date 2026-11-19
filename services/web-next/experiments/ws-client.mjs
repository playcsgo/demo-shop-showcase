// 透過 Next.js 的 /support 連到假 support-api：分別試「只用 WebSocket」和「預設（先 polling 再升級）」
import { io } from 'socket.io-client'

const base = process.env.BASE ?? 'http://127.0.0.1:3000'
const headers = { Origin: 'http://shop.example.test', Cookie: 'sid=abc123' }

async function attempt(label, transports) {
  return new Promise((resolve) => {
    const out = { label, connected: false }
    const s = io(base, { path: '/support/socket.io', transports, extraHeaders: headers, reconnection: false, timeout: 5000 })
    const done = () => { s.close(); resolve(out) }
    s.on('hello', (h) => { out.hello = h })
    s.on('upgraded', (t) => { out.upgradedTo = t })
    s.on('connect', () => {
      out.connected = true
      s.emit('ping1', 'hi', (r) => { out.ack = r; setTimeout(done, 1500) }) // 等一下看有沒有升級成 websocket
    })
    s.on('connect_error', (e) => { out.error = e.message; done() })
    setTimeout(done, 8000)
  })
}

const http = await fetch(`${base}/support/api/ping?x=1`, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: e.message }))
console.log(JSON.stringify({ http }, null, 1))
for (const [label, t] of [['websocket-only', ['websocket']], ['default', ['polling', 'websocket']]]) console.log(JSON.stringify(await attempt(label, t), null, 1))
process.exit(0)
