import { all, get, run, tx } from './db.js'
import { broadcast } from './realtime.js'

export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location' | 'contact' | 'other'

export interface IncomingMessage {
  numberId: number
  jid: string
  /** Customer phone number (digits only) or, if WhatsApp hides it, the opaque JID. */
  phone: string
  waName?: string
  waId: string
  fromMe: boolean
  senderId?: number | null
  type: MessageType
  body: string
  mediaPath?: string | null
  mediaMime?: string | null
  ts: number
  aiAssisted?: boolean
  /** Live messages bump unread counts; history-sync backfill does not. */
  live: boolean
}

const PREVIEW_LABEL: Record<MessageType, string> = {
  text: '', image: '📷 相片', video: '🎬 影片', audio: '🎵 音訊', voice: '🎤 語音',
  document: '📄 文件', sticker: '貼圖', location: '📍 位置', contact: '👤 聯絡人', other: '訊息',
}

export function previewOf(type: MessageType, body: string) {
  const label = PREVIEW_LABEL[type]
  if (!body) return label
  return label ? `${label} ${body}` : body
}

export function upsertContact(phone: string, waName?: string): number {
  const existing = get<{ id: number; wa_name: string | null }>(
    'SELECT id, wa_name FROM contacts WHERE phone = ?', phone,
  )
  if (existing) {
    if (waName && waName !== existing.wa_name) {
      run('UPDATE contacts SET wa_name = ?, updated_at = unixepoch() WHERE id = ?', waName, existing.id)
    }
    return existing.id
  }
  return Number(run('INSERT INTO contacts (phone, wa_name) VALUES (?, ?)', phone, waName ?? null).lastInsertRowid)
}

function upsertConversation(numberId: number, jid: string, contactId: number): number {
  const existing = get<{ id: number }>(
    'SELECT id FROM conversations WHERE number_id = ? AND jid = ?', numberId, jid,
  )
  if (existing) return existing.id
  return Number(
    run('INSERT INTO conversations (number_id, contact_id, jid) VALUES (?, ?, ?)', numberId, contactId, jid)
      .lastInsertRowid,
  )
}

/**
 * Store a message (idempotent on WhatsApp's message id) and update the conversation.
 * Every message ever seen by a linked number lands here: this is the automatic backup.
 */
export function storeMessage(m: IncomingMessage): { conversationId: number; messageId: number } | null {
  const result = tx(() => {
    const contactId = upsertContact(m.phone, m.fromMe ? undefined : m.waName)
    const conversationId = upsertConversation(m.numberId, m.jid, contactId)
    const inserted = run(
      `INSERT OR IGNORE INTO messages
         (conversation_id, wa_id, from_me, sender_id, type, body, media_path, media_mime, ts, ai_assisted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId, m.waId, m.fromMe ? 1 : 0, m.senderId ?? null, m.type, m.body,
      m.mediaPath ?? null, m.mediaMime ?? null, m.ts, m.aiAssisted ? 1 : 0,
    )
    if (inserted.changes === 0) return null
    const messageId = Number(inserted.lastInsertRowid)
    run(
      `UPDATE conversations SET
         last_message_at = MAX(last_message_at, ?1),
         last_preview = CASE WHEN ?1 >= last_message_at THEN ?2 ELSE last_preview END,
         unread = CASE WHEN ?3 THEN unread + 1 WHEN ?4 THEN 0 ELSE unread END,
         status = CASE WHEN ?3 THEN 'open' ELSE status END
       WHERE id = ?5`,
      m.ts, previewOf(m.type, m.body), !m.fromMe && m.live ? 1 : 0, m.fromMe && m.live ? 1 : 0, conversationId,
    )
    return { conversationId, messageId }
  })
  if (result && m.live) {
    broadcast('message', getMessage(result.messageId))
    broadcast('conversation', getConversation(result.conversationId))
  }
  return result
}

/** Attach media that finished downloading after the message row was written. */
export function setMessageMedia(numberId: number, jid: string, waId: string, mediaPath: string, mime: string) {
  run(
    `UPDATE messages SET media_path = ?, media_mime = ?
     WHERE wa_id = ? AND conversation_id = (SELECT id FROM conversations WHERE number_id = ? AND jid = ?)`,
    mediaPath, mime, waId, numberId, jid,
  )
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.number_id, c.contact_id, c.jid, c.assignee_id, c.status, c.unread,
         c.last_message_at, c.last_preview,
         ct.phone, COALESCE(ct.name, ct.wa_name, ct.phone) AS contact_name,
         n.label AS number_label, n.phone AS number_phone
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN numbers n ON n.id = c.number_id`

export function getConversation(id: number) {
  return get(`${CONVERSATION_SELECT} WHERE c.id = ?`, id)
}

export function listConversations(filter: {
  view: string; userId: number; numberId?: number; contactId?: number; q?: string
}) {
  const where: string[] = []
  const params: any[] = []
  if (filter.contactId) { where.push('c.contact_id = ?'); params.push(filter.contactId) }
  else if (filter.view === 'mine') { where.push("c.assignee_id = ? AND c.status = 'open'"); params.push(filter.userId) }
  else if (filter.view === 'unassigned') where.push("c.assignee_id IS NULL AND c.status = 'open'")
  else if (filter.view === 'closed') where.push("c.status = 'closed'")
  else where.push("c.status = 'open'")
  if (filter.numberId) { where.push('c.number_id = ?'); params.push(filter.numberId) }
  if (filter.q) {
    where.push('(ct.name LIKE ? OR ct.wa_name LIKE ? OR ct.phone LIKE ?)')
    params.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`)
  }
  return all(
    `${CONVERSATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 300`,
    ...params,
  )
}

export function getMessage(id: number) {
  return get(
    `SELECT m.*, u.name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    id,
  )
}

/** Messages and internal events, merged into one timeline. */
export function getTimeline(conversationId: number) {
  const messages = all(
    `SELECT 'message' AS item, m.*, u.name AS sender_name
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.ts DESC LIMIT 500`,
    conversationId,
  ).reverse()
  const events = all(
    `SELECT 'event' AS item, e.*, u.name AS user_name, t.name AS target_name
     FROM events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users t ON t.id = e.target_user_id
     WHERE e.conversation_id = ? ORDER BY e.ts`,
    conversationId,
  )
  return [...messages, ...events].sort((a, b) => a.ts - b.ts)
}

export function addEvent(conversationId: number, userId: number | null, kind: string, body = '', targetUserId: number | null = null) {
  const id = Number(
    run(
      'INSERT INTO events (conversation_id, user_id, kind, body, target_user_id) VALUES (?, ?, ?, ?, ?)',
      conversationId, userId, kind, body, targetUserId,
    ).lastInsertRowid,
  )
  const event = get(
    `SELECT 'event' AS item, e.*, u.name AS user_name, t.name AS target_name
     FROM events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users t ON t.id = e.target_user_id
     WHERE e.id = ?`,
    id,
  )
  broadcast('event', event)
  return event
}
