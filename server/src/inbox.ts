import { CONTACT_NAME_SQL, CONTACT_PHONE_SQL, all, get, run, tx } from './db.js'
import { broadcast } from './realtime.js'

export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location' | 'contact' | 'other'

export interface IncomingMessage {
  numberId: number
  jid: string
  /** Who the customer is: phone number and/or LID, digits only. At least one is required. */
  contact: ContactIds
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

export interface ContactIds {
  /** Real phone number, digits only. */
  pn?: string
  /** WhatsApp LID, digits only. */
  lid?: string
}

/** "85291234567@s.whatsapp.net" or "1234:5@lid" -> digits only. */
export function jidDigits(jid: string | null | undefined): string | undefined {
  return jid ? jid.split('@')[0].split(':')[0] || undefined : undefined
}

export function pnForLid(lid: string): string | undefined {
  return get<{ pn: string }>('SELECT pn FROM lid_map WHERE lid = ?', lid)?.pn
}

/**
 * Record that a LID belongs to a phone number. If Baton already has the customer
 * under their LID, the real number is filled in and any duplicate is merged.
 * Returns true if an existing contact changed.
 */
export function rememberLid(lid: string, pn: string): boolean {
  if (!lid || !pn || lid === pn) return false
  const known = pnForLid(lid)
  if (known !== pn) run('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)', lid, pn)
  const unresolved = get<{ id: number }>('SELECT id FROM contacts WHERE lid = ? AND phone = ?', lid, lid)
  if (!unresolved) return false
  resolveContact({ pn, lid })
  return true
}

/**
 * Find or create the one company contact for a customer, given whatever WhatsApp
 * told us (phone number, LID, or both), and keep their names up to date.
 */
export function resolveContact(ids: ContactIds, names: { saved?: string; wa?: string } = {}): number {
  return tx(() => {
    const lid = ids.lid
    const pn = ids.pn ?? (lid ? pnForLid(lid) : undefined)
    if (!pn && !lid) throw new Error('Contact needs a phone number or LID')
    const byPn = pn ? get<{ id: number }>('SELECT id FROM contacts WHERE phone = ?', pn) : undefined
    const byLid = lid ? get<{ id: number }>('SELECT id FROM contacts WHERE lid = ? OR phone = ?', lid, lid) : undefined

    let id: number
    if (byPn && byLid && byPn.id !== byLid.id) {
      mergeContacts(byLid.id, byPn.id)
      id = byPn.id
    } else if (byPn ?? byLid) {
      id = (byPn ?? byLid)!.id
    } else {
      id = Number(run('INSERT INTO contacts (phone, lid) VALUES (?, ?)', pn ?? lid, lid ?? null).lastInsertRowid)
    }
    if (pn) run('UPDATE contacts SET phone = ? WHERE id = ? AND phone != ?', pn, id, pn)
    if (lid) run('UPDATE contacts SET lid = ? WHERE id = ? AND lid IS NULL', lid, id)
    const saved = names.saved ?? get<{ name: string }>('SELECT name FROM phonebook WHERE key IN (?, ?)', pn ?? '', lid ?? '')?.name
    if (saved) run('UPDATE contacts SET saved_name = ?, updated_at = unixepoch() WHERE id = ? AND saved_name IS NOT ?', saved, id, saved)
    if (names.wa) run('UPDATE contacts SET wa_name = ?, updated_at = unixepoch() WHERE id = ? AND wa_name IS NOT ?', names.wa, id, names.wa)
    return id
  })
}

/** Fold a duplicate contact into the one we keep. Nothing the team wrote is lost. */
function mergeContacts(fromId: number, intoId: number) {
  const from = get<{ name: string | null; saved_name: string | null; wa_name: string | null; notes: string; owner_id: number | null; lid: string | null }>(
    'SELECT name, saved_name, wa_name, notes, owner_id, lid FROM contacts WHERE id = ?', fromId,
  )!
  run('UPDATE contacts SET lid = NULL WHERE id = ?', fromId)
  run(
    `UPDATE contacts SET name = COALESCE(name, ?), saved_name = COALESCE(saved_name, ?), wa_name = COALESCE(wa_name, ?),
       owner_id = COALESCE(owner_id, ?), lid = COALESCE(lid, ?),
       notes = CASE WHEN notes = '' THEN ? WHEN ? = '' THEN notes ELSE notes || char(10) || ? END
     WHERE id = ?`,
    from.name, from.saved_name, from.wa_name, from.owner_id, from.lid, from.notes, from.notes, from.notes, intoId,
  )
  run('UPDATE deals SET contact_id = ? WHERE contact_id = ?', intoId, fromId)
  for (const c of all<{ id: number; number_id: number }>('SELECT id, number_id FROM conversations WHERE contact_id = ?', fromId)) {
    const twin = get<{ id: number }>('SELECT id FROM conversations WHERE contact_id = ? AND number_id = ?', intoId, c.number_id)
    if (twin) mergeConversations(c.id, twin.id)
    else run('UPDATE conversations SET contact_id = ? WHERE id = ?', intoId, c.id)
  }
  run('DELETE FROM contacts WHERE id = ?', fromId)
}

/** The same chat seen under a LID and under a phone number becomes one conversation. */
function mergeConversations(fromId: number, intoId: number) {
  const from = get<{ unread: number; assignee_id: number | null; status: string }>(
    'SELECT unread, assignee_id, status FROM conversations WHERE id = ?', fromId,
  )!
  run('UPDATE OR IGNORE messages SET conversation_id = ? WHERE conversation_id = ?', intoId, fromId)
  run('DELETE FROM messages WHERE conversation_id = ?', fromId)
  run('UPDATE events SET conversation_id = ? WHERE conversation_id = ?', intoId, fromId)
  run('UPDATE deals SET conversation_id = ? WHERE conversation_id = ?', intoId, fromId)
  const latest = get<{ ts: number; type: MessageType; body: string }>(
    'SELECT ts, type, body FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT 1', intoId,
  )
  run(
    `UPDATE conversations SET unread = unread + ?, assignee_id = COALESCE(assignee_id, ?),
       status = CASE WHEN ? = 'open' THEN 'open' ELSE status END,
       last_message_at = COALESCE(?, last_message_at), last_preview = COALESCE(?, last_preview)
     WHERE id = ?`,
    from.unread, from.assignee_id, from.status, latest?.ts ?? null,
    latest ? previewOf(latest.type, latest.body) : null, intoId,
  )
  run('DELETE FROM conversations WHERE id = ?', fromId)
}

function upsertConversation(numberId: number, jid: string, contactId: number): number {
  // Look up by chat first, then by customer: WhatsApp may address one chat by LID and by phone number.
  const existing =
    get<{ id: number }>('SELECT id FROM conversations WHERE number_id = ? AND jid = ?', numberId, jid) ??
    get<{ id: number }>('SELECT id FROM conversations WHERE number_id = ? AND contact_id = ?', numberId, contactId)
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
    const contactId = resolveContact(m.contact, { wa: m.fromMe ? undefined : m.waName })
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
export function setMessageMedia(numberId: number, waId: string, mediaPath: string, mime: string) {
  run(
    `UPDATE messages SET media_path = ?, media_mime = ?
     WHERE wa_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE number_id = ?)`,
    mediaPath, mime, waId, numberId,
  )
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.number_id, c.contact_id, c.jid, c.assignee_id, c.status, c.unread,
         c.last_message_at, c.last_preview,
         ${CONTACT_PHONE_SQL} AS phone, ${CONTACT_NAME_SQL} AS contact_name,
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
    where.push('(ct.name LIKE ? OR ct.saved_name LIKE ? OR ct.wa_name LIKE ? OR ct.phone LIKE ?)')
    params.push(...Array(4).fill(`%${filter.q}%`))
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
