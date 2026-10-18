import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookieParser from 'cookie-parser'
import express, { type NextFunction, type Request, type Response } from 'express'
import { Server } from 'socket.io'
import { ZodError } from 'zod'
import { SESSION_COOKIE, userForToken } from './auth.js'
import { setIo } from './realtime.js'
import { api, media } from './routes.js'
import { restoreAll } from './whatsapp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4000)

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/api', api)
app.use('/media', media)

const webDist = path.resolve(here, '../../web/dist')
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get(/^\/(?!api|media|socket\.io).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: '資料格式不正確', issues: err.issues })
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

server.listen(PORT, () => {
  console.log(`Baton 接棒 running on http://localhost:${PORT}`)
  restoreAll().catch((err) => console.error('Failed to restore WhatsApp sessions', err))
})
