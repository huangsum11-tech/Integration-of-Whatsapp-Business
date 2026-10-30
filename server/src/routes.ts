import path from 'node:path'
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { AiUnavailableError, draftReply, testReply } from './ai.js'
import { teamAnalytics } from './analytics.js'
import {
  SESSION_COOKIE, createSession, hashPassword, requireAdmin, requireUser, verifyPassword,
} from './auth.js'
import { canSend, sendReply } from './channels.js'
import { CONTACT_NAME_SQL, CONTACT_PHONE_SQL, all, get, getSetting, run, setSetting, tx } from './db.js'
import { addEvent, getConversation, getTimeline, listConversations } from './inbox.js'
import { PROVIDERS, currentAi, hasKey, type Provider } from './llm.js'
import { handleWebhook, validSignature, verifyCloud, verifyInstagram } from './meta.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR, connectNumber, currentQr, disconnectNumber, isConnected, syncContacts } from './whatsapp.js'

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

// ---------- WhatsApp & Instagram numbers ----------

api.get('/numbers', (_req, res) => {
  const numbers = all<{ id: number; config: string }>(
    `SELECT n.*, (SELECT COUNT(*) FROM conversations c WHERE c.number_id = n.id) AS conversations
     FROM numbers n ORDER BY n.id`,
  )
  // Access tokens never leave the server; only the IDs are shown.
  res.json(numbers.map(({ config, ...n }) => {
    const { accessToken: _token, ...ids } = JSON.parse(config || '{}')
    return { ...n, ids, qr: currentQr(n.id) ?? null }
  }))
})

const newNumber = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('wa_web'), label: z.string().min(1).max(60) }),
  z.object({
    channel: z.literal('wa_cloud'), label: z.string().min(1).max(60),
    phoneNumberId: z.string().regex(/^\d+$/, '電話號碼 ID 只包含數字'), accessToken: z.string().min(20),
  }),
  z.object({ channel: z.literal('instagram'), label: z.string().min(1).max(60), accessToken: z.string().min(20) }),
])

/** Check official API credentials with Meta before saving them. */
async function officialConfig(b: z.infer<typeof newNumber>) {
  if (b.channel === 'wa_cloud') {
    const info = await verifyCloud({ phoneNumberId: b.phoneNumberId, accessToken: b.accessToken })
    return { phone: info.phone, key: 'phoneNumberId', id: b.phoneNumberId, config: { phoneNumberId: b.phoneNumberId, accessToken: b.accessToken } }
  }
  if (b.channel === 'instagram') {
    const info = await verifyInstagram(b.accessToken)
    return {
      phone: info.username ? `@${info.username}` : null, key: 'igUserId', id: info.igUserId,
      config: { igUserId: info.igUserId, username: info.username, accessToken: b.accessToken },
    }
  }
  throw new Error('不支援的連接方式')
}

api.post('/numbers', requireAdmin, async (req, res) => {
  // Older clients send only a label, meaning a QR-linked number.
  const b = body(z.preprocess((v) => ({ channel: 'wa_web', ...(v as object) }), newNumber), req)
  if (b.channel === 'wa_web') {
    const id = Number(run("INSERT INTO numbers (label, status) VALUES (?, 'starting')", b.label).lastInsertRowid)
    await connectNumber(id)
    return res.json({ id })
  }
  let official
  try {
    official = await officialConfig(b)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : '未能驗證連接資料' })
  }
  const existing = get<{ id: number }>(
    `SELECT id FROM numbers WHERE channel = ? AND json_extract(config, '$.${official.key}') = ?`, b.channel, official.id,
  )
  if (existing) {
    // Reconnecting the same account (e.g. with a new token) keeps its conversations.
    run("UPDATE numbers SET label = ?, phone = ?, config = ?, status = 'connected' WHERE id = ?", b.label, official.phone, JSON.stringify(official.config), existing.id)
    broadcast('number', { id: existing.id, status: 'connected' })
    return res.json({ id: existing.id })
  }
  const id = Number(run("INSERT INTO numbers (label, phone, channel, config, status) VALUES (?, ?, ?, ?, 'connected')",
    b.label, official.phone, b.channel, JSON.stringify(official.config)).lastInsertRowid)
  res.json({ id })
})

api.patch('/numbers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({ label: z.string().min(1).max(60).optional(), reply_mode: z.enum(['off', 'suggest', 'auto']).optional() }), req)
  if (!get('SELECT id FROM numbers WHERE id = ?', id)) return res.status(404).json({ error: '找不到號碼' })
  if (b.label) run('UPDATE numbers SET label = ? WHERE id = ?', b.label, id)
  if (b.reply_mode) run('UPDATE numbers SET reply_mode = ? WHERE id = ?', b.reply_mode, id)
  broadcast('number', { id, ...b })
  res.json({ ok: true })
})

api.post('/numbers/:id/reconnect', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const number = get<{ demo: number; channel: string }>('SELECT demo, channel FROM numbers WHERE id = ?', id)
  if (!number) return res.status(404).json({ error: '找不到號碼' })
  if (number.demo) return res.status(400).json({ error: '示範號碼不能連接' })
  if (number.channel !== 'wa_web') return res.status(400).json({ error: '官方 API 號碼請用「連接新號碼」重新輸入存取權杖' })
  await connectNumber(id)
  res.json({ ok: true })
})

/** Unlink the device (or forget the API token). Conversations, contacts and media remain in the company's backup. */
api.post('/numbers/:id/unlink', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const number = get<{ channel: string; config: string }>('SELECT channel, config FROM numbers WHERE id = ?', id)
  if (!number) return res.status(404).json({ error: '找不到號碼' })
  if (number.channel === 'wa_web') {
    await disconnectNumber(id, true)
  } else {
    const { accessToken: _token, ...ids } = JSON.parse(number.config || '{}')
    run('UPDATE numbers SET config = ? WHERE id = ?', JSON.stringify(ids), id)
  }
  run("UPDATE numbers SET status = 'unlinked' WHERE id = ?", id)
  broadcast('number', { id, status: 'unlinked' })
  res.json({ ok: true })
})

/** Fill in hidden phone numbers and re-download saved names from the phone's contact list. */
api.post('/numbers/:id/sync-contacts', requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!isConnected(id)) return res.status(409).json({ error: '此號碼未連接（只適用於 QR Code 連接的號碼）' })
  res.json(await syncContacts(id, undefined, true))
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
  const contact = getContact(conversation.contact_id)
  const deals = all('SELECT d.*, u.name AS user_name FROM deals d LEFT JOIN users u ON u.id = d.user_id WHERE d.contact_id = ? ORDER BY d.created_at DESC', conversation.contact_id)
  const otherConversations = all(
    `SELECT c.id, c.last_message_at, c.last_preview, n.label AS number_label
     FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.contact_id = ? AND c.id != ?`,
    conversation.contact_id, id,
  )
  res.json({ conversation, contact, deals, otherConversations, timeline: getTimeline(id), canSend: canSend(conversation.number_id) })
})

api.post('/conversations/:id/read', (req, res) => {
  const id = Number(req.params.id)
  run('UPDATE conversations SET unread = 0 WHERE id = ?', id)
  broadcast('conversation', getConversation(id))
  res.json({ ok: true })
})

api.patch('/conversations/:id', (req, res) => {
  const id = Number(req.params.id)
  const { status } = body(z.object({ status: z.enum(['open', 'closed']) }), req)
  // Closing ends the human takeover: the AI handles this customer's next question again.
  run(`UPDATE conversations SET status = ?1,
         ai_paused = CASE WHEN ?1 = 'closed' THEN 0 ELSE ai_paused END,
         ai_suggestion = CASE WHEN ?1 = 'closed' THEN NULL ELSE ai_suggestion END
       WHERE id = ?2`, status, id)
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
  // Replying claims an unassigned conversation, so two teammates don't answer the same customer.
  if (!conversation.assignee_id) {
    run('UPDATE conversations SET assignee_id = ? WHERE id = ?', req.user.id, id)
    addEvent(id, req.user.id, 'assign', '', req.user.id)
  }
  await sendReply(id, b.text, { userId: req.user.id, aiAssisted: b.aiAssisted })
  res.json({ ok: true })
})

/** Pause or resume automatic AI replies in one conversation. */
api.post('/conversations/:id/ai', (req, res) => {
  const id = Number(req.params.id)
  const { paused } = body(z.object({ paused: z.boolean() }), req)
  if (!getConversation(id)) return res.status(404).json({ error: '找不到對話' })
  run('UPDATE conversations SET ai_paused = ? WHERE id = ?', paused ? 1 : 0, id)
  addEvent(id, req.user.id, paused ? 'ai_paused' : 'ai_resumed')
  broadcast('conversation', getConversation(id))
  res.json({ ok: true })
})

api.delete('/conversations/:id/suggestion', (req, res) => {
  const id = Number(req.params.id)
  run('UPDATE conversations SET ai_suggestion = NULL WHERE id = ?', id)
  broadcast('conversation', getConversation(id))
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

// ---------- AI: provider, business profile, knowledge base ----------

api.get('/ai/settings', (_req, res) => {
  const { provider, model } = currentAi()
  res.json({
    provider, model,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, keyEnv: p.keyEnv, hasKey: hasKey(id as Provider), defaultModel: p.defaultModel,
      model: getSetting(`ai_model_${id}`) || p.defaultModel,
    })),
    business_name: getSetting('business_name'),
    business_intro: getSetting('business_intro'),
    handoff_message: getSetting('handoff_message'),
  })
})

api.put('/ai/settings', requireAdmin, (req, res) => {
  const b = body(z.object({
    provider: z.enum(['claude', 'gemini', 'grok']).optional(),
    model: z.string().max(100).optional(),
    business_name: z.string().max(120).optional(),
    business_intro: z.string().max(4000).optional(),
    handoff_message: z.string().max(500).optional(),
  }), req)
  tx(() => {
    if (b.provider) setSetting('ai_provider', b.provider)
    if (b.model !== undefined) setSetting(`ai_model_${b.provider ?? currentAi().provider}`, b.model.trim())
    for (const key of ['business_name', 'business_intro', 'handoff_message'] as const) {
      if (b[key] !== undefined) setSetting(key, b[key]!)
    }
  })
  res.json({ ok: true })
})

/** Ask the customer assistant a question without sending anything to anyone. */
api.post('/ai/test', async (req, res) => {
  const { question } = body(z.object({ question: z.string().min(1).max(1000) }), req)
  try {
    res.json(await testReply(question))
  } catch (err) {
    res.status(err instanceof AiUnavailableError ? 503 : 502).json({ error: err instanceof Error ? err.message : 'AI 測試失敗' })
  }
})

const knowledgeEntry = z.object({
  category: z.enum(['faq', 'policy', 'class', 'other']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  keywords: z.string().max(500).default(''),
  active: z.boolean().default(true),
})

api.get('/knowledge', (_req, res) => {
  res.json(all('SELECT * FROM knowledge ORDER BY category, id'))
})

api.post('/knowledge', requireAdmin, (req, res) => {
  const b = body(knowledgeEntry, req)
  const id = run('INSERT INTO knowledge (category, title, body, keywords, active) VALUES (?, ?, ?, ?, ?)',
    b.category, b.title, b.body, b.keywords, b.active ? 1 : 0).lastInsertRowid
  res.json(get('SELECT * FROM knowledge WHERE id = ?', Number(id)))
})

api.put('/knowledge/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const b = body(knowledgeEntry, req)
  run('UPDATE knowledge SET category = ?, title = ?, body = ?, keywords = ?, active = ?, updated_at = unixepoch() WHERE id = ?',
    b.category, b.title, b.body, b.keywords, b.active ? 1 : 0, id)
  res.json(get('SELECT * FROM knowledge WHERE id = ?', id))
})

api.delete('/knowledge/:id', requireAdmin, (req, res) => {
  run('DELETE FROM knowledge WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

// ---------- Company contact book ----------

/** Contact columns with phone hidden (NULL) while WhatsApp only gave us a LID. */
const CONTACT_COLUMNS = `ct.id, ${CONTACT_PHONE_SQL} AS phone, ct.lid, ct.name, ct.saved_name, ct.wa_name, ct.notes,
  ct.owner_id, ct.created_at, ct.updated_at, ct.phone LIKE 'ig:%' AS instagram`

function getContact(id: number) {
  return get(`SELECT ${CONTACT_COLUMNS} FROM contacts ct WHERE ct.id = ?`, id)
}

api.get('/contacts', (req, res) => {
  const q = req.query.q ? `%${String(req.query.q)}%` : '%'
  res.json(all(
    `SELECT ${CONTACT_COLUMNS}, ${CONTACT_NAME_SQL} AS display_name, u.name AS owner_name,
       (SELECT COUNT(*) FROM conversations c WHERE c.contact_id = ct.id) AS conversations,
       (SELECT GROUP_CONCAT(DISTINCT n.label) FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.contact_id = ct.id) AS numbers,
       (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.contact_id = ct.id) AS last_message_at,
       (SELECT COALESCE(SUM(amount), 0) FROM deals d WHERE d.contact_id = ct.id AND d.stage = 'won') AS won_amount
     FROM contacts ct LEFT JOIN users u ON u.id = ct.owner_id
     WHERE ct.name LIKE ?1 OR ct.saved_name LIKE ?1 OR ct.wa_name LIKE ?1 OR ct.phone LIKE ?1 OR (?1 = '%')
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
  broadcast('contact', getContact(id))
  res.json(getContact(id))
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
      ${CONTACT_NAME_SQL} AS contact_name, n.label AS number_label
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

// ---------- Meta webhook (WhatsApp Cloud API & Instagram) ----------

export const webhooks = express.Router()

/** Meta's one-time check when the webhook URL is saved in the app dashboard. */
webhooks.get('/meta', (req, res) => {
  const token = process.env.META_VERIFY_TOKEN
  if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''))
  }
  res.sendStatus(403)
})

webhooks.post('/meta', (req, res) => {
  if (!validSignature((req as Request & { rawBody?: Buffer }).rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401)
  // Acknowledge at once; Meta retries deliveries that take too long.
  res.sendStatus(200)
  try {
    handleWebhook(req.body)
  } catch (err) {
    console.error('Webhook handling failed', err)
  }
})

// ---------- Backed-up media (signed-in teammates only) ----------

export const media = express.Router()
media.use(requireUser)
media.use(express.static(path.resolve(MEDIA_DIR), { fallthrough: false, dotfiles: 'deny' }))
