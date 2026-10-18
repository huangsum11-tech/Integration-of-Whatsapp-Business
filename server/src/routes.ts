import path from 'node:path'
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { AiUnavailableError, draftReply } from './ai.js'
import { teamAnalytics } from './analytics.js'
import {
  SESSION_COOKIE, createSession, hashPassword, requireAdmin, requireUser, verifyPassword,
} from './auth.js'
import { all, get, run, tx } from './db.js'
import { addEvent, getConversation, getTimeline, listConversations, storeMessage } from './inbox.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR, connectNumber, currentQr, disconnectNumber, isConnected, sendText } from './whatsapp.js'

export const api = express.Router()

const TEAM_COLORS = ['#0E7C66', '#F26B4F', '#6C5CE7', '#D99A1E', '#2F80ED', '#C2477A', '#3D9970', '#8E6C4A']

function body<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.body)
}

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400 * 1000,
  })
}

// ---------- Setup & auth ----------

api.get('/setup', (_req, res) => {
  const row = get<{ c: number }>('SELECT COUNT(*) AS c FROM users')
  res.json({ needsSetup: !row?.c })
})

api.post('/setup', (req, res) => {
  if (get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c) return res.status(409).json({ error: '已完成設定' })
  const b = body(z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8) }), req)
  const id = Number(
    run("INSERT INTO users (name, email, password_hash, role, color) VALUES (?, ?, ?, 'admin', ?)",
      b.name, b.email.toLowerCase(), hashPassword(b.password), TEAM_COLORS[0]).lastInsertRowid,
  )
  setSessionCookie(res, createSession(id))
  res.json({ ok: true })
})

api.post('/login', (req, res) => {
  const b = body(z.object({ email: z.string(), password: z.string() }), req)
  const user = get<{ id: number; password_hash: string; active: number }>(
    'SELECT id, password_hash, active FROM users WHERE email = ?', b.email.toLowerCase(),
  )
  if (!user || !user.active || !verifyPassword(b.password, user.password_hash)) {
    return res.status(401).json({ error: '電郵或密碼不正確' })
  }
  setSessionCookie(res, createSession(user.id))
  res.json({ ok: true })
})

api.post('/logout', (req, res) => {
  run('DELETE FROM sessions WHERE token = ?', req.cookies?.[SESSION_COOKIE] ?? '')
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})

api.use(requireUser)

api.get('/me', (req, res) => res.json(req.user))

api.patch('/me', (req, res) => {
  const b = body(z.object({ name: z.string().min(1).optional(), style_notes: z.string().max(2000).optional() }), req)
  if (b.name) run('UPDATE users SET name = ? WHERE id = ?', b.name, req.user.id)
  if (b.style_notes !== undefined) run('UPDATE users SET style_notes = ? WHERE id = ?', b.style_notes, req.user.id)
  res.json(get('SELECT id, name, email, role, active, color, style_notes FROM users WHERE id = ?', req.user.id))
})

// ---------- Team ----------

api.get('/users', (_req, res) => {
  res.json(all(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.color, u.created_at, u.deactivated_at,
       (SELECT COUNT(*) FROM conversations c WHERE c.assignee_id = u.id AND c.status = 'open') AS open_conversations,
       (SELECT COUNT(*) FROM contacts ct WHERE ct.owner_id = u.id) AS owned_contacts
     FROM users u ORDER BY u.active DESC, u.name`,
  ))
})

api.post('/users', requireAdmin, (req, res) => {
  const b = body(z.object({
    name: z.string().min(1), email: z.string().email(), password: z.string().min(8),
    role: z.enum(['admin', 'agent']).default('agent'),
  }), req)
  if (get('SELECT id FROM users WHERE email = ?', b.email.toLowerCase())) return res.status(409).json({ error: '此電郵已被使用' })
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM users')!.c
  const id = run('INSERT INTO users (name, email, password_hash, role, color) VALUES (?, ?, ?, ?, ?)',
    b.name, b.email.toLowerCase(), hashPassword(b.password), b.role, TEAM_COLORS[count % TEAM_COLORS.length]).lastInsertRowid
  res.json({ id: Number(id) })
})

/**
 * A teammate leaves: their login stops working immediately, and every open conversation,
 * contact and open deal they owned moves to a colleague. Nothing is deleted.
 */
api.post('/users/:id/offboard', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { reassignTo } = body(z.object({ reassignTo: z.number().int() }), req)
  if (id === req.user.id) return res.status(400).json({ error: '不能停用自己的帳戶' })
  if (!get('SELECT id FROM users WHERE id = ? AND active = 1', reassignTo)) return res.status(400).json({ error: '接手同事無效' })
  const moved = tx(() => {
    const conversations = all<{ id: number }>("SELECT id FROM conversations WHERE assignee_id = ? AND status = 'open'", id)
    run("UPDATE conversations SET assignee_id = ? WHERE assignee_id = ? AND status = 'open'", reassignTo, id)
    const contacts = run('UPDATE contacts SET owner_id = ? WHERE owner_id = ?', reassignTo, id).changes
    const deals = run("UPDATE deals SET user_id = ? WHERE user_id = ? AND stage = 'open'", reassignTo, id).changes
    run('UPDATE users SET active = 0, deactivated_at = unixepoch() WHERE id = ?', id)
    run('DELETE FROM sessions WHERE user_id = ?', id)
    for (const c of conversations) addEvent(c.id, req.user.id, 'offboard', '', reassignTo)
    return { conversations: conversations.length, contacts: Number(contacts), deals: Number(deals) }
  })
  broadcast('refresh', { scope: 'all' })
  res.json(moved)
})

// ---------- WhatsApp numbers ----------

api.get('/numbers', (_req, res) => {
  const numbers = all(
    `SELECT n.*, (SELECT COUNT(*) FROM conversations c WHERE c.number_id = n.id) AS conversations
     FROM numbers n ORDER BY n.id`,
  )
  res.json(numbers.map((n) => ({ ...n, qr: currentQr(n.id) ?? null })))
})

api.post('/numbers', requireAdmin, async (req, res) => {
  const { label } = body(z.object({ label: z.string().min(1).max(60) }), req)
  const id = Number(run("INSERT INTO numbers (label, status) VALUES (?, 'starting')", label).lastInsertRowid)
  await connectNumber(id)
  res.json({ id })
})

api.post('/numbers/:id/reconnect', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const number = get<{ demo: number }>('SELECT demo FROM numbers WHERE id = ?', id)
  if (!number) return res.status(404).json({ error: '找不到號碼' })
  if (number.demo) return res.status(400).json({ error: '示範號碼不能連接' })
  await connectNumber(id)
  res.json({ ok: true })
})

/** Unlink the device. Conversations, contacts and media remain in the company's backup. */
api.post('/numbers/:id/unlink', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  await disconnectNumber(id, true)
  run("UPDATE numbers SET status = 'unlinked' WHERE id = ?", id)
  broadcast('number', { id, status: 'unlinked' })
  res.json({ ok: true })
})

// ---------- Inbox ----------

api.get('/conversations', (req, res) => {
  res.json(listConversations({
    view: String(req.query.view ?? 'all'),
    userId: req.user.id,
    numberId: req.query.numberId ? Number(req.query.numberId) : undefined,
    contactId: req.query.contactId ? Number(req.query.contactId) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
  }))
})

api.get('/conversations/counts', (req, res) => {
  res.json(get(
    `SELECT
       SUM(status = 'open') AS "all",
       SUM(status = 'open' AND assignee_id = ?) AS mine,
       SUM(status = 'open' AND assignee_id IS NULL) AS unassigned,
       SUM(status = 'closed') AS closed
     FROM conversations`,
    req.user.id,
  ))
})

api.get('/conversations/:id', (req, res) => {
  const id = Number(req.params.id)
  const conversation = getConversation(id)
  if (!conversation) return res.status(404).json({ error: '找不到對話' })
  const contact = get('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)
  const deals = all('SELECT d.*, u.name AS user_name FROM deals d LEFT JOIN users u ON u.id = d.user_id WHERE d.contact_id = ? ORDER BY d.created_at DESC', conversation.contact_id)
  const otherConversations = all(
    `SELECT c.id, c.last_message_at, c.last_preview, n.label AS number_label
     FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.contact_id = ? AND c.id != ?`,
    conversation.contact_id, id,
  )
  res.json({ conversation, contact, deals, otherConversations, timeline: getTimeline(id), canSend: canSend(conversation.number_id) })
})

function canSend(numberId: number) {
  const n = get<{ demo: number }>('SELECT demo FROM numbers WHERE id = ?', numberId)
  return Boolean(n?.demo) || isConnected(numberId)
}

api.post('/conversations/:id/read', (req, res) => {
  const id = Number(req.params.id)
  run('UPDATE conversations SET unread = 0 WHERE id = ?', id)
  broadcast('conversation', getConversation(id))
  res.json({ ok: true })
})

api.patch('/conversations/:id', (req, res) => {
  const id = Number(req.params.id)
  const { status } = body(z.object({ status: z.enum(['open', 'closed']) }), req)
  run('UPDATE conversations SET status = ? WHERE id = ?', status, id)
  addEvent(id, req.user.id, status === 'closed' ? 'close' : 'reopen')
  broadcast('conversation', getConversation(id))
  res.json({ ok: true })
})

/** Assign or hand off a conversation, optionally with a note for the colleague taking over. */
api.post('/conversations/:id/assign', (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({ userId: z.number().int().nullable(), note: z.string().max(2000).default('') }), req)
  const current = getConversation(id)
  if (!current) return res.status(404).json({ error: '找不到對話' })
  run('UPDATE conversations SET assignee_id = ? WHERE id = ?', b.userId, id)
  const kind = b.userId === null ? 'unassign' : current.assignee_id ? 'handoff' : 'assign'
  addEvent(id, req.user.id, kind, b.note, b.userId)
  broadcast('conversation', getConversation(id))
  res.json({ ok: true })
})

api.post('/conversations/:id/notes', (req, res) => {
  const { body: text } = body(z.object({ body: z.string().min(1).max(4000) }), req)
  res.json(addEvent(Number(req.params.id), req.user.id, 'note', text))
})

api.post('/conversations/:id/messages', async (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({ text: z.string().min(1).max(4096), aiAssisted: z.boolean().default(false) }), req)
  const conversation = getConversation(id)
  if (!conversation) return res.status(404).json({ error: '找不到對話' })
  const number = get<{ demo: number }>('SELECT demo FROM numbers WHERE id = ?', conversation.number_id)
  // Replying claims an unassigned conversation, so two teammates don't answer the same customer.
  if (!conversation.assignee_id) {
    run('UPDATE conversations SET assignee_id = ? WHERE id = ?', req.user.id, id)
    addEvent(id, req.user.id, 'assign', '', req.user.id)
  }
  if (number?.demo) {
    storeMessage({
      numberId: conversation.number_id, jid: conversation.jid, phone: conversation.phone,
      waId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, fromMe: true,
      senderId: req.user.id, aiAssisted: b.aiAssisted, type: 'text', body: b.text,
      ts: Math.floor(Date.now() / 1000), live: true,
    })
  } else {
    await sendText(conversation.number_id, conversation.jid, b.text, req.user.id, b.aiAssisted)
  }
  res.json({ ok: true })
})

api.post('/conversations/:id/draft', async (req, res) => {
  const { instruction } = body(z.object({ instruction: z.string().max(500).optional() }), req)
  try {
    res.json({ draft: await draftReply(Number(req.params.id), req.user.id, instruction) })
  } catch (err) {
    const status = err instanceof AiUnavailableError ? 503 : 502
    res.status(status).json({ error: err instanceof Error ? err.message : 'AI 草擬失敗' })
  }
})

// ---------- Company contact book ----------

api.get('/contacts', (req, res) => {
  const q = req.query.q ? `%${String(req.query.q)}%` : '%'
  res.json(all(
    `SELECT ct.*, COALESCE(ct.name, ct.wa_name, ct.phone) AS display_name, u.name AS owner_name,
       (SELECT COUNT(*) FROM conversations c WHERE c.contact_id = ct.id) AS conversations,
       (SELECT GROUP_CONCAT(DISTINCT n.label) FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.contact_id = ct.id) AS numbers,
       (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.contact_id = ct.id) AS last_message_at,
       (SELECT COALESCE(SUM(amount), 0) FROM deals d WHERE d.contact_id = ct.id AND d.stage = 'won') AS won_amount
     FROM contacts ct LEFT JOIN users u ON u.id = ct.owner_id
     WHERE ct.name LIKE ?1 OR ct.wa_name LIKE ?1 OR ct.phone LIKE ?1 OR (?1 = '%')
     ORDER BY last_message_at DESC NULLS LAST LIMIT 500`,
    q,
  ))
})

api.patch('/contacts/:id', (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({
    name: z.string().max(120).nullable().optional(),
    notes: z.string().max(4000).optional(),
    owner_id: z.number().int().nullable().optional(),
  }), req)
  if (b.name !== undefined) run('UPDATE contacts SET name = ? WHERE id = ?', b.name || null, id)
  if (b.notes !== undefined) run('UPDATE contacts SET notes = ? WHERE id = ?', b.notes, id)
  if (b.owner_id !== undefined) run('UPDATE contacts SET owner_id = ? WHERE id = ?', b.owner_id, id)
  run('UPDATE contacts SET updated_at = unixepoch() WHERE id = ?', id)
  // A renamed contact is renamed in every number's inbox at once.
  broadcast('contact', get('SELECT * FROM contacts WHERE id = ?', id))
  res.json(get('SELECT * FROM contacts WHERE id = ?', id))
})

// ---------- Deals ----------

api.post('/deals', (req, res) => {
  const b = body(z.object({
    contact_id: z.number().int(), conversation_id: z.number().int().nullable().default(null),
    title: z.string().min(1).max(200), amount: z.number().min(0).default(0),
  }), req)
  const id = run('INSERT INTO deals (contact_id, conversation_id, user_id, title, amount) VALUES (?, ?, ?, ?, ?)',
    b.contact_id, b.conversation_id, req.user.id, b.title, b.amount).lastInsertRowid
  res.json(get('SELECT * FROM deals WHERE id = ?', Number(id)))
})

api.patch('/deals/:id', (req, res) => {
  const id = Number(req.params.id)
  const { stage } = body(z.object({ stage: z.enum(['open', 'won', 'lost']) }), req)
  run("UPDATE deals SET stage = ?, closed_at = CASE WHEN ? = 'open' THEN NULL ELSE unixepoch() END WHERE id = ?", stage, stage, id)
  const deal = get<{ conversation_id: number | null; title: string }>('SELECT * FROM deals WHERE id = ?', id)
  if (deal?.conversation_id && stage !== 'open') addEvent(deal.conversation_id, req.user.id, `deal_${stage}`, deal.title)
  res.json(deal)
})

// ---------- Search & analytics ----------

api.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (!q) return res.json([])
  const select = `SELECT m.id, m.conversation_id, m.body, m.ts, m.from_me, m.type,
      COALESCE(ct.name, ct.wa_name, ct.phone) AS contact_name, n.label AS number_label
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id JOIN numbers n ON n.id = c.number_id`
  // The trigram index needs 3+ characters; shorter queries (e.g. two Chinese characters) use LIKE.
  const rows = [...q].length >= 3
    ? all(`${select} WHERE m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.ts DESC LIMIT 100`,
      `"${q.replaceAll('"', '""')}"`)
    : all(`${select} WHERE m.body LIKE ? ORDER BY m.ts DESC LIMIT 100`, `%${q}%`)
  res.json(rows)
})

api.get('/analytics', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365)
  res.json(teamAnalytics(days))
})

// ---------- Backed-up media (signed-in teammates only) ----------

export const media = express.Router()
media.use(requireUser)
media.use(express.static(path.resolve(MEDIA_DIR), { fallthrough: false, dotfiles: 'deny' }))
