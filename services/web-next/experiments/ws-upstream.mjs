// WEB-001 實驗用的假 support-api：socket.io 預設 path（/socket.io），回報它看到的 Origin、Host、cookie
import { createServer } from 'node:http'
import { Server } from 'socket.io'

const http = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, xff: req.headers['x-forwarded-for'] ?? null }))
})
const io = new Server(http)
io.on('connection', (s) => {
  const h = s.handshake.headers
  s.emit('hello', { transport: s.conn.transport.name, host: h.host, origin: h.origin ?? null, cookie: h.cookie ?? null })
  s.conn.on('upgrade', (t) => s.emit('upgraded', t.name))
  s.on('ping1', (msg, ack) => ack({ echo: msg, transport: s.conn.transport.name }))
})
http.listen(Number(process.env.PORT ?? 3999), () => console.log('upstream ready'))
