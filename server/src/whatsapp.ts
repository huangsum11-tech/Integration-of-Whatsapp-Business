/**
 * Links existing WhatsApp Business numbers as "linked devices" (the same mechanism
 * WhatsApp Web uses), so there is no Cloud/Platform API application, no business
 * verification and no number migration. One Baileys socket per number.
 */
import fs from 'node:fs'
import path from 'node:path'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import { DATA_DIR, get, run } from './db.js'
import { setMessageMedia, storeMessage, upsertContact, type MessageType } from './inbox.js'
import { broadcast } from './realtime.js'

const logger = pino({ level: process.env.BATON_WA_LOG ?? 'warn' })
const sockets = new Map<number, WASocket>()
const latestQr = new Map<number, string>()
const reconnectAttempts = new Map<number, number>()
/** Numbers deliberately unlinked; their sockets must not auto-reconnect. */
const stopped = new Set<number>()
/** Messages sent from Baton, so their echo is attributed to the teammate who sent them. */
const sentByTeammate = new Map<string, { userId: number; aiAssisted: boolean }>()

const authDir = (numberId: number) => path.join(DATA_DIR, 'auth', String(numberId))
export const MEDIA_DIR = path.join(DATA_DIR, 'media')

function setStatus(numberId: number, status: string, extra: Record<string, unknown> = {}) {
  run('UPDATE numbers SET status = ? WHERE id = ?', status, numberId)
  broadcast('number', { id: numberId, status, ...extra })
}

export function currentQr(numberId: number) {
  return latestQr.get(numberId)
}

export async function connectNumber(numberId: number) {
  if (sockets.has(numberId)) return
  stopped.delete(numberId)
  const { state, saveCreds } = await useMultiFileAuthState(authDir(numberId))
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.macOS('Baton'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
  })
  sockets.set(numberId, sock)
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
      latestQr.set(numberId, dataUrl)
      setStatus(numberId, 'qr', { qr: dataUrl })
    }
    if (connection === 'open') {
      latestQr.delete(numberId)
      reconnectAttempts.delete(numberId)
      const phone = sock.user?.id ? jidNormalizedUser(sock.user.id).split('@')[0] : null
      run('UPDATE numbers SET phone = COALESCE(?, phone) WHERE id = ?', phone, numberId)
      setStatus(numberId, 'connected', { phone })
    }
    if (connection === 'close') {
      if (sockets.get(numberId) === sock) sockets.delete(numberId)
      if (stopped.has(numberId)) return
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(authDir(numberId), { recursive: true, force: true })
        setStatus(numberId, 'logged_out')
      } else if (get('SELECT id FROM numbers WHERE id = ?', numberId)) {
        // Back off from 3s up to 1 min so an offline network isn't hammered.
        const attempt = reconnectAttempts.get(numberId) ?? 0
        reconnectAttempts.set(numberId, attempt + 1)
        setStatus(numberId, 'reconnecting')
        setTimeout(() => {
          if (!stopped.has(numberId)) connectNumber(numberId).catch((err) => logger.error(err))
        }, Math.min(60000, 3000 * 2 ** attempt))
      }
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) ingest(numberId, sock, msg, type === 'notify')
  })

  sock.ev.on('messaging-history.set', ({ messages, contacts }) => {
    for (const c of contacts) {
      const phone = c.phoneNumber ?? (c.id.endsWith('@s.whatsapp.net') ? c.id : undefined)
      if (phone && (c.name || c.notify)) upsertContact(phone.split('@')[0], c.name ?? c.notify)
    }
    for (const msg of messages) ingest(numberId, sock, msg, false)
    broadcast('sync', { numberId })
  })
}

export async function disconnectNumber(numberId: number, logout: boolean) {
  const sock = sockets.get(numberId)
  stopped.add(numberId)
  sockets.delete(numberId)
  latestQr.delete(numberId)
  reconnectAttempts.delete(numberId)
  if (sock) {
    if (logout) await sock.logout().catch(() => {})
    else sock.end(undefined)
  }
  if (logout) fs.rmSync(authDir(numberId), { recursive: true, force: true })
}

/** Reconnect every number that has saved credentials (on server start). */
export async function restoreAll() {
  const numbers = get<{ c: number }>('SELECT COUNT(*) AS c FROM numbers')
  if (!numbers?.c) return
  for (const dir of fs.existsSync(path.join(DATA_DIR, 'auth')) ? fs.readdirSync(path.join(DATA_DIR, 'auth')) : []) {
    const id = Number(dir)
    if (get('SELECT id FROM numbers WHERE id = ? AND demo = 0', id)) {
      connectNumber(id).catch((err) => logger.error(err))
    }
  }
}

export async function sendText(numberId: number, jid: string, text: string, userId: number, aiAssisted: boolean) {
  const sock = sockets.get(numberId)
  if (!sock) throw new Error('此號碼未連接')
  const sent = await sock.sendMessage(jid, { text })
  if (!sent?.key.id) throw new Error('發送失敗')
  sentByTeammate.set(sent.key.id, { userId, aiAssisted })
  ingest(numberId, sock, sent, true)
  return sent.key.id
}

const MEDIA_TYPES: Partial<Record<string, MessageType>> = {
  imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio',
  documentMessage: 'document', documentWithCaptionMessage: 'document', stickerMessage: 'sticker',
}

function describe(msg: WAMessage): { type: MessageType; body: string } | null {
  const content = normalizeMessageContent(msg.message)
  const kind = getContentType(content ?? undefined)
  if (!content || !kind) return null
  switch (kind) {
    case 'conversation': return { type: 'text', body: content.conversation ?? '' }
    case 'extendedTextMessage': return { type: 'text', body: content.extendedTextMessage?.text ?? '' }
    case 'imageMessage': return { type: 'image', body: content.imageMessage?.caption ?? '' }
    case 'videoMessage': return { type: 'video', body: content.videoMessage?.caption ?? '' }
    case 'audioMessage': return { type: content.audioMessage?.ptt ? 'voice' : 'audio', body: '' }
    case 'documentMessage':
      return { type: 'document', body: content.documentMessage?.fileName ?? content.documentMessage?.caption ?? '' }
    case 'stickerMessage': return { type: 'sticker', body: '' }
    case 'locationMessage': {
      const l = content.locationMessage
      return { type: 'location', body: [l?.name, l?.address, `${l?.degreesLatitude},${l?.degreesLongitude}`].filter(Boolean).join(' · ') }
    }
    case 'contactMessage': return { type: 'contact', body: content.contactMessage?.displayName ?? '' }
    // Reactions, receipts, edits, deletes, etc. are not conversation content.
    case 'reactionMessage': case 'protocolMessage': case 'senderKeyDistributionMessage':
    case 'messageContextInfo': case 'pollUpdateMessage':
      return null
    default: return { type: 'other', body: '' }
  }
}

function ingest(numberId: number, sock: WASocket, msg: WAMessage, live: boolean) {
  const jid = msg.key.remoteJid
  if (!jid || !msg.key.id || !msg.message) return
  // Team inbox covers 1:1 customer chats; groups, broadcasts and Status are skipped.
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || jid.endsWith('@newsletter')) return
  const described = describe(msg)
  if (!described) return

  const phoneJid = isLidUser(jid) ? msg.key.remoteJidAlt : jid
  const phone = (phoneJid ?? jid).split('@')[0]
  const fromMe = Boolean(msg.key.fromMe)
  const attribution = fromMe ? sentByTeammate.get(msg.key.id) : undefined
  const ts = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000))

  const stored = storeMessage({
    numberId, jid, phone, waName: msg.pushName ?? undefined, waId: msg.key.id, fromMe,
    senderId: attribution?.userId ?? null, aiAssisted: attribution?.aiAssisted ?? false,
    type: described.type, body: described.body, ts, live,
  })
  if (attribution) sentByTeammate.delete(msg.key.id)

  const content = normalizeMessageContent(msg.message)
  const kind = getContentType(content ?? undefined)
  if (stored && kind && MEDIA_TYPES[kind]) saveMedia(numberId, sock, msg, jid, kind).catch(() => {
    // Old history-sync media may have expired on WhatsApp's servers; the text record still stands.
  })
}

async function saveMedia(numberId: number, sock: WASocket, msg: WAMessage, jid: string, kind: string) {
  const content = normalizeMessageContent(msg.message) as Record<string, any>
  const mime: string = content[kind]?.mimetype ?? 'application/octet-stream'
  const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin'
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  const rel = path.join(String(numberId), `${msg.key.id}.${ext}`)
  fs.mkdirSync(path.join(MEDIA_DIR, String(numberId)), { recursive: true })
  fs.writeFileSync(path.join(MEDIA_DIR, rel), buffer)
  setMessageMedia(numberId, jid, msg.key.id!, rel, mime)
  broadcast('media', { waId: msg.key.id, mediaPath: rel, mime })
}

export function isConnected(numberId: number) {
  return sockets.has(numberId)
}
