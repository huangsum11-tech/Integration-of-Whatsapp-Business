import './env.js'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookieParser from 'cookie-parser'
import express, { type NextFunction, type Request, type Response } from 'express'
import QRCode from 'qrcode'
import { Server } from 'socket.io'
import { ZodError } from 'zod'
import { SESSION_COOKIE, userForToken } from './auth.js'
import { setIo } from './realtime.js'
import './autoreply.js'
import { startAutomation } from './automation.js'
import { startPayrollScheduler } from './payroll.js'
import { api, media, webhooks } from './routes.js'
import { restoreAll } from './whatsapp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4000)

const app = express()
// Keep the raw body: Meta webhook signatures are computed over the exact bytes.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf } }))
app.use(cookieParser())
app.use('/webhooks', webhooks)
app.use('/api', api)
app.use('/media', media)

const webDist = path.resolve(here, '../../web/dist')
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get(/^\/(?!api|media|webhooks|socket\.io).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    // Our own messages are in Chinese; zod's built-in ones are not shown to staff.
    const own = err.issues.find((i) => /[\u4e00-\u9fff]/.test(i.message))?.message
    return res.status(400).json({ error: own ?? '資料格式不正確', issues: err.issues })
  }
  const status = (err as { status?: number }).status
  if (status === 404) return res.status(404).json({ error: '找不到' })
  console.error(err)
  res.status(500).json({ error: err instanceof Error ? err.message : '伺服器錯誤' })
})

const server = http.createServer(app)
const io = new Server(server)
io.use((socket, next) => {
  const cookies = Object.fromEntries(
    (socket.handshake.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)),
  )
  const user = userForToken(cookies[SESSION_COOKIE])
  if (!user) return next(new Error('unauthorized'))
  socket.data.user = user
  next()
})
io.on('connection', (socket) => socket.join('team'))
setIo(io)

/** This computer's addresses on the local network, so phones on the same Wi-Fi can connect. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address)
    // Home and office Wi-Fi is usually 192.168.x.x; VPN and Docker adapters tend to use 10.x or 172.x.
    .sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')))
}

server.listen(PORT, async () => {
  console.log(`\nBaton 接棒 running on http://localhost:${PORT}`)
  const [first, ...rest] = lanAddresses()
  if (first) {
    const url = `http://${first}:${PORT}`
    console.log(`\n手機（同一個 Wi-Fi）打開：${url}`)
    for (const ip of rest) console.log(`  打不開的話試：http://${ip}:${PORT}`)
    console.log('\n或用手機相機掃描：')
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }))
  }
  if (!process.env.META_APP_SECRET && !process.env.INSTAGRAM_APP_SECRET) {
    console.warn('未設定 META_APP_SECRET：/webhooks/meta 不會驗證 Meta 簽名，正式使用前請設定')
  }
  restoreAll().catch((err) => console.error('Failed to restore WhatsApp sessions', err))
  startPayrollScheduler()
  startAutomation()
})
