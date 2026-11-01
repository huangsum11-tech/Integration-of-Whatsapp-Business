import path from 'node:path'
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { AiUnavailableError, draftReply, testReply } from './ai.js'
import { teamAnalytics } from './analytics.js'
import {
  SESSION_COOKIE, createSession, hashPassword, requireAdmin, requireUser, verifyPassword,
} from './auth.js'
import { canSend, sendReply, sendToPhone } from './channels.js'
import { CONTACT_NAME_SQL, CONTACT_PHONE_SQL, SOCIAL_SQL, all, get, getSetting, run, setSetting, tx } from './db.js'
import { INSTRUCTOR_CHAT_SQL, addEvent, getConversation, getTimeline, listConversations } from './inbox.js'
import { TEMPLATE_PATH, exportCsv, importCsv, importTemplate } from './knowledge.js'
import { PROVIDERS, currentAi, hasKey, type Provider } from './llm.js'
import {
  DEFAULT_TEMPLATE, analyzeReport, createRun, getRun, listRuns, payrollSettings, render, savePayrollSettings, sendRun,
} from './payroll.js'
import { normalizePhone } from './channels.js'
import {
  DEFAULT_FOLLOWUP, automationSettings, recordTrial, saveAutomationSettings, trialsForContact, upcomingTrials, waitingCustomers,
} from './automation.js'
import { parseLocal } from './time.js'
import { reportSettings, saveReportSettings, sendWeeklyReport, weeklyReport } from './report.js'
import { canTranscribe } from './transcribe.js'
import {
  SEGMENTS, allTags, audienceContacts, getCampaign, importContacts, listCampaigns, saveCampaign, sendCampaign, sendTest, setTags, tagsFor,
} from './campaigns.js'
import { handleWebhook, subscribeWebhooks, validSignature, verifyCloud, verifyInstagram, verifyMessenger } from './meta.js'
import { verifyThreads } from './threads.js'
import { setupStatus } from './setup.js'
import { homeData } from './home.js'
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
  const b = body(z.object({ name: z.string().min(1).optional(), style_notes: z.string().max(2000).optional(), phone: z.string().max(30).optional() }), req)
  if (b.name) run('UPDATE users SET name = ? WHERE id = ?', b.name, req.user.id)
  if (b.style_notes !== undefined) run('UPDATE users SET style_notes = ? WHERE id = ?', b.style_notes, req.user.id)
  if (b.phone !== undefined) run('UPDATE users SET phone = ? WHERE id = ?', b.phone ? normalizePhone(b.phone) : '', req.user.id)
  res.json(get('SELECT id, name, email, role, active, color, style_notes, phone FROM users WHERE id = ?', req.user.id))
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
  z.object({
    channel: z.literal('messenger'), label: z.string().min(1).max(60),
    pageId: z.string().regex(/^\d+$/, '專頁 ID 只包含數字'), accessToken: z.string().min(20),
  }),
  z.object({ channel: z.literal('threads'), label: z.string().min(1).max(60), accessToken: z.string().min(20) }),
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
      config: { igUserId: info.igUserId, username: info.username, accessToken: b.accessToken, refreshedAt: Math.floor(Date.now() / 1000) },
    }
  }
  if (b.channel === 'messenger') {
    const info = await verifyMessenger(b.pageId, b.accessToken)
    return { phone: info.name || null, key: 'pageId', id: info.pageId, config: { pageId: info.pageId, name: info.name, accessToken: b.accessToken } }
  }
  if (b.channel === 'threads') {
    const info = await verifyThreads(b.accessToken)
    return {
      phone: info.username ? `@${info.username}` : null, key: 'userId', id: info.userId,
      config: { userId: info.userId, username: info.username, accessToken: b.accessToken, refreshedAt: Math.floor(Date.now() / 1000) },
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
  // Point the Page / Instagram account's events at this app. If it fails, the dashboard can do it.
  let warning: string | undefined
  try {
    await subscribeWebhooks(b.channel, official.config as unknown as Record<string, string>)
  } catch (err) {
    warning = `已連接，但未能自動訂閱 webhook（${err instanceof Error ? err.message : ''}）。請在 Meta App 的 Webhooks 設定手動訂閱。`
  }
  const existing = get<{ id: number }>(
    `SELECT id FROM numbers WHERE channel = ? AND json_extract(config, '$.${official.key}') = ?`, b.channel, official.id,
  )
  if (existing) {
    // Reconnecting the same account (e.g. with a new token) keeps its conversations.
    run("UPDATE numbers SET label = ?, phone = ?, config = ?, status = 'connected' WHERE id = ?", b.label, official.phone, JSON.stringify(official.config), existing.id)
    broadcast('number', { id: existing.id, status: 'connected' })
    return res.json({ id: existing.id, warning })
  }
  const id = Number(run("INSERT INTO numbers (label, phone, channel, config, status) VALUES (?, ?, ?, ?, 'connected')",
    b.label, official.phone, b.channel, JSON.stringify(official.config)).lastInsertRowid)
  res.json({ id, warning })
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

api.get('/setup-status', (_req, res) => res.json(setupStatus()))

api.get('/home', (req, res) => res.json(homeData(req.user.id, req.user.role === 'admin')))

// ---------- Inbox ----------

api.get('/conversations', (req, res) => {
  res.json(listConversations({
    view: String(req.query.view ?? 'all'),
    userId: req.user.id,
    admin: req.user.role === 'admin',
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
       SUM(status = 'closed') AS closed,
       SUM(status = 'open' AND needs_human = 1) AS human
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE ? OR NOT (${INSTRUCTOR_CHAT_SQL})`,
    req.user.id, req.user.role === 'admin' ? 1 : 0,
  ))
})

api.get('/conversations/:id', (req, res) => {
  const id = Number(req.params.id)
  const conversation = getConversation(id)
  if (!conversation || (req.user.role !== 'admin' && isInstructorChat(id))) return res.status(404).json({ error: '找不到對話' })
  const contact = getContact(conversation.contact_id)
  const deals = all('SELECT d.*, u.name AS user_name FROM deals d LEFT JOIN users u ON u.id = d.user_id WHERE d.contact_id = ? ORDER BY d.created_at DESC', conversation.contact_id)
  const trials = trialsForContact(conversation.contact_id)
  const tags = tagsFor(conversation.contact_id)
  const otherConversations = all(
    `SELECT c.id, c.last_message_at, c.last_preview, n.label AS number_label
     FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.contact_id = ? AND c.id != ?`,
    conversation.contact_id, id,
  )
  res.json({ conversation, contact, deals, trials, tags, otherConversations, timeline: getTimeline(id), canSend: canSend(conversation.number_id) })
})

function isInstructorChat(conversationId: number) {
  return Boolean(get(`SELECT 1 FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ? AND ${INSTRUCTOR_CHAT_SQL}`, conversationId))
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
  // Closing ends the human takeover: the AI handles this customer's next question again.
  run(`UPDATE conversations SET status = ?1,
         ai_paused = CASE WHEN ?1 = 'closed' THEN 0 ELSE ai_paused END,
         ai_suggestion = CASE WHEN ?1 = 'closed' THEN NULL ELSE ai_suggestion END,
         needs_human = CASE WHEN ?1 = 'closed' THEN 0 ELSE needs_human END
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
    trial_booking_url: getSetting('trial_booking_url'),
    booking_url: getSetting('booking_url'),
  })
})

api.put('/ai/settings', requireAdmin, (req, res) => {
  const b = body(z.object({
    provider: z.enum(['claude', 'gemini', 'grok']).optional(),
    model: z.string().max(100).optional(),
    business_name: z.string().max(120).optional(),
    business_intro: z.string().max(4000).optional(),
    handoff_message: z.string().max(500).optional(),
    trial_booking_url: z.string().max(500).optional(),
    booking_url: z.string().max(500).optional(),
  }), req)
  tx(() => {
    if (b.provider) setSetting('ai_provider', b.provider)
    if (b.model !== undefined) setSetting(`ai_model_${b.provider ?? currentAi().provider}`, b.model.trim())
    for (const key of ['business_name', 'business_intro', 'handoff_message', 'trial_booking_url', 'booking_url'] as const) {
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

/** The whole knowledge base as a spreadsheet (opens in Excel / Google Sheets). */
api.get('/knowledge/export.csv', (_req, res) => {
  res.attachment('baton-knowledge.csv').type('text/csv; charset=utf-8').send(exportCsv())
})

/** The blank Pilates / fitness studio template to fill in. */
api.get('/knowledge/template.csv', (_req, res) => {
  res.attachment('knowledge-template.csv').type('text/csv; charset=utf-8').sendFile(TEMPLATE_PATH)
})

api.post('/knowledge/import', requireAdmin, (req, res) => {
  const b = body(z.object({ csv: z.string().min(1).max(900_000).optional(), template: z.boolean().optional(), replace: z.boolean().default(false) }), req)
  try {
    res.json(b.template ? importTemplate() : importCsv(b.csv ?? '', b.replace))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '匯入失敗' })
  }
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

// ---------- Trials, follow-ups, alerts, quick replies ----------

api.post('/conversations/:id/trials', (req, res) => {
  const b = body(z.object({ at: z.string(), class_name: z.string().max(120).default('') }), req)
  const at = parseLocal(b.at)
  if (!at) return res.status(400).json({ error: '日期時間格式不正確' })
  res.json({ id: recordTrial(Number(req.params.id), at, b.class_name, 'staff', req.user.id) })
})

api.patch('/trials/:id', (req, res) => {
  const b = body(z.object({
    at: z.string().optional(), class_name: z.string().max(120).optional(),
    status: z.enum(['booked', 'cancelled']).optional(), followup: z.enum(['pending', 'skipped']).optional(),
  }), req)
  const id = Number(req.params.id)
  if (b.at) {
    const at = parseLocal(b.at)
    if (!at) return res.status(400).json({ error: '日期時間格式不正確' })
    // A new time means a new follow-up.
    run("UPDATE trials SET class_at = ?, followup_status = 'pending', followup_error = NULL WHERE id = ?", at, id)
  }
  if (b.class_name !== undefined) run('UPDATE trials SET class_name = ? WHERE id = ?', b.class_name, id)
  if (b.status) run('UPDATE trials SET status = ? WHERE id = ?', b.status, id)
  if (b.followup) run('UPDATE trials SET followup_status = ?, followup_error = NULL WHERE id = ?', b.followup, id)
  broadcast('trial', {})
  res.json({ ok: true })
})

api.get('/automation', (_req, res) => {
  res.json({
    settings: automationSettings(),
    defaultFollowup: DEFAULT_FOLLOWUP,
    trials: upcomingTrials(),
    waiting: waitingCustomers(0).length,
    team: all("SELECT id, name, phone, active FROM users WHERE active = 1 ORDER BY name"),
    report: reportSettings(),
    review: { url: getSetting('google_review_url'), message: getSetting('review_message', DEFAULT_REVIEW) },
    transcription: canTranscribe(),
  })
})

api.put('/automation/settings', requireAdmin, (req, res) => {
  const b = body(z.object({
    notify_number_id: z.number().int().nullable().optional(),
    followup_enabled: z.boolean().optional(),
    followup_minutes: z.number().int().min(0).max(24 * 60).optional(),
    followup_message: z.string().min(1).max(2000).optional(),
    followup_wa_template_name: z.string().max(200).optional(),
    followup_wa_template_language: z.string().max(20).optional(),
    alert_enabled: z.boolean().optional(),
    alert_minutes: z.number().int().min(1).max(24 * 60).optional(),
    alert_phone: z.string().max(30).optional(),
    alert_from_hour: z.number().int().min(0).max(23).optional(),
    alert_to_hour: z.number().int().min(1).max(24).optional(),
  }), req)
  saveAutomationSettings(b)
  res.json(automationSettings())
})

api.put('/automation/report', requireAdmin, (req, res) => {
  saveReportSettings(body(z.object({
    report_enabled: z.boolean().optional(), report_phones: z.string().max(300).optional(),
    report_weekday: z.number().int().min(0).max(6).optional(), report_hour: z.number().int().min(0).max(23).optional(),
  }), req))
  res.json(reportSettings())
})

api.get('/automation/report/preview', requireAdmin, (_req, res) => res.json({ text: weeklyReport() }))

api.post('/automation/report/send', requireAdmin, async (_req, res) => {
  try {
    res.json({ sent: await sendWeeklyReport() })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '發送失敗' })
  }
})

const DEFAULT_REVIEW = '{名稱} 多謝你今日嚟上堂！😊 如果你鍾意我哋嘅課堂，可唔可以幫我哋寫個 Google 評價？對我哋幫助好大🙏\n{連結}'

api.put('/automation/review', requireAdmin, (req, res) => {
  const b = body(z.object({ url: z.string().max(500), message: z.string().min(1).max(1000) }), req)
  setSetting('google_review_url', b.url.trim())
  setSetting('review_message', b.message)
  res.json({ ok: true })
})

/** Ask this customer for a Google review, with the saved message and link. */
api.post('/conversations/:id/review', async (req, res) => {
  const id = Number(req.params.id)
  const url = getSetting('google_review_url')
  if (!url) return res.status(400).json({ error: '請先在「自動化」頁填寫 Google 評價連結' })
  const conversation = getConversation(id)
  if (!conversation) return res.status(404).json({ error: '找不到對話' })
  const text = getSetting('review_message', DEFAULT_REVIEW)
    .replaceAll('{名稱}', String(conversation.contact_name).split(/[\s(（]/)[0]).replaceAll('{連結}', url)
  try {
    await sendReply(id, text, { userId: req.user.id })
    addEvent(id, req.user.id, 'review')
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '發送失敗' })
  }
})

api.patch('/users/:id/phone', requireAdmin, (req, res) => {
  const { phone } = body(z.object({ phone: z.string().max(30) }), req)
  run('UPDATE users SET phone = ? WHERE id = ?', phone ? normalizePhone(phone) : '', Number(req.params.id))
  res.json({ ok: true })
})

api.get('/quick-replies', (_req, res) => {
  res.json(all('SELECT * FROM quick_replies ORDER BY shortcut'))
})

const quickReply = z.object({ shortcut: z.string().trim().min(1).max(30).regex(/^[^\s/]+$/, '捷徑不可以有空格或 /'), body: z.string().min(1).max(4000) })

api.post('/quick-replies', requireAdmin, (req, res) => {
  const b = body(quickReply, req)
  if (get('SELECT id FROM quick_replies WHERE shortcut = ?', b.shortcut)) return res.status(409).json({ error: '已有同名捷徑' })
  run('INSERT INTO quick_replies (shortcut, body) VALUES (?, ?)', b.shortcut, b.body)
  res.json({ ok: true })
})

api.put('/quick-replies/:id', requireAdmin, (req, res) => {
  const b = body(quickReply, req)
  run('UPDATE quick_replies SET shortcut = ?, body = ? WHERE id = ?', b.shortcut, b.body, Number(req.params.id))
  res.json({ ok: true })
})

api.delete('/quick-replies/:id', requireAdmin, (req, res) => {
  run('DELETE FROM quick_replies WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

// ---------- Marketing: tags, broadcasts, Instagram comment rules ----------

api.get('/tags', (_req, res) => res.json(allTags()))

api.put('/contacts/:id/tags', (req, res) => {
  const { tags } = body(z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(30) }), req)
  setTags(Number(req.params.id), tags)
  res.json(tagsFor(Number(req.params.id)))
})

api.post('/contacts/import', requireAdmin, (req, res) => {
  const b = body(z.object({ csv: z.string().min(1).max(900_000), tag: z.string().max(30).default('') }), req)
  try {
    res.json(importContacts(b.csv, b.tag))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '匯入失敗' })
  }
})

const audience = z.object({ segment: z.enum(Object.keys(SEGMENTS) as [keyof typeof SEGMENTS]), tags: z.array(z.string()).default([]) })

api.post('/audience/preview', requireAdmin, (req, res) => {
  const contacts = audienceContacts(body(audience, req))
  res.json({ count: contacts.length, sample: contacts.slice(0, 8).map((c) => c.name) })
})

api.get('/campaigns', requireAdmin, (_req, res) => {
  res.json({ campaigns: listCampaigns(), segments: SEGMENTS, tags: allTags(), price: Number(getSetting('marketing_price', '0.64')) })
})

const campaignInput = z.object({
  name: z.string().trim().min(1).max(120), number_id: z.number().int().nullable(), audience,
  message: z.string().max(4000).default(''),
  wa_template_name: z.string().max(200).default(''), wa_template_language: z.string().max(20).default('zh_HK'),
  wa_template_params: z.string().max(500).default(''),
  ai_note: z.string().max(4000).default(''), ai_until: z.number().int().nullable().default(null),
})

api.post('/campaigns', requireAdmin, (req, res) => {
  res.json(getCampaign(saveCampaign(body(campaignInput, req), req.user.id)))
})

api.get('/campaigns/:id', requireAdmin, (req, res) => {
  const c = getCampaign(Number(req.params.id))
  if (!c) return res.status(404).json({ error: '找不到群發' })
  res.json(c)
})

api.put('/campaigns/:id', requireAdmin, (req, res) => {
  try {
    res.json(getCampaign(saveCampaign(body(campaignInput, req), req.user.id, Number(req.params.id))))
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : '未能儲存' })
  }
})

api.delete('/campaigns/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (get("SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'", id)) return res.status(409).json({ error: '已有訊息發出，不能刪除' })
  run('DELETE FROM campaigns WHERE id = ?', id)
  res.json({ ok: true })
})

api.post('/campaigns/:id/test', requireAdmin, async (req, res) => {
  const { phone } = body(z.object({ phone: z.string().min(8).max(30) }), req)
  try {
    await sendTest(Number(req.params.id), phone, req.user.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '測試發送失敗' })
  }
})

/** Send now, schedule (at = unix seconds), or cancel a schedule (at = null). Sending again retries failures. */
api.post('/campaigns/:id/send', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { at } = body(z.object({ at: z.number().int().nullable().optional() }), req)
  const c = get<{ status: string; number_id: number | null; message: string }>('SELECT status, number_id, message FROM campaigns WHERE id = ?', id)
  if (!c) return res.status(404).json({ error: '找不到群發' })
  if (c.status === 'sending') return res.status(409).json({ error: '正在發送中' })
  if (!c.number_id) return res.status(400).json({ error: '請先選擇發送號碼' })
  if (!c.message.trim()) return res.status(400).json({ error: '請先填寫訊息內容' })
  if (at === null) run("UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'", id)
  else if (at && at > Date.now() / 1000) run("UPDATE campaigns SET status = 'scheduled', scheduled_at = ? WHERE id = ?", at, id)
  else sendCampaign(id).catch((err) => console.error('Broadcast failed', err))
  broadcast('campaign', { id })
  res.json({ ok: true })
})

api.put('/marketing/price', requireAdmin, (req, res) => {
  const { price } = body(z.object({ price: z.number().min(0).max(100) }), req)
  setSetting('marketing_price', String(price))
  res.json({ ok: true })
})

api.get('/ig-rules', requireAdmin, (_req, res) => {
  res.json({
    rules: all('SELECT r.*, n.label AS number_label FROM ig_rules r LEFT JOIN numbers n ON n.id = r.number_id ORDER BY r.id DESC'),
    comments: all('SELECT * FROM ig_comments ORDER BY created_at DESC LIMIT 50'),
  })
})

const igRule = z.object({
  number_id: z.number().int().nullable().default(null), keywords: z.string().trim().min(1).max(300),
  reply: z.string().trim().min(1).max(1000), public_reply: z.string().max(300).default(''), active: z.boolean().default(true),
})

api.post('/ig-rules', requireAdmin, (req, res) => {
  const b = body(igRule, req)
  run('INSERT INTO ig_rules (number_id, keywords, reply, public_reply, active) VALUES (?, ?, ?, ?, ?)', b.number_id, b.keywords, b.reply, b.public_reply, b.active ? 1 : 0)
  res.json({ ok: true })
})

api.put('/ig-rules/:id', requireAdmin, (req, res) => {
  const b = body(igRule, req)
  run('UPDATE ig_rules SET number_id = ?, keywords = ?, reply = ?, public_reply = ?, active = ? WHERE id = ?',
    b.number_id, b.keywords, b.reply, b.public_reply, b.active ? 1 : 0, Number(req.params.id))
  res.json({ ok: true })
})

api.delete('/ig-rules/:id', requireAdmin, (req, res) => {
  run('DELETE FROM ig_rules WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

// ---------- Instructor payroll (admin only) ----------

api.get('/payroll', requireAdmin, (_req, res) => {
  res.json({
    settings: payrollSettings(),
    defaultTemplate: DEFAULT_TEMPLATE,
    instructors: all('SELECT * FROM instructors ORDER BY active DESC, name'),
    runs: listRuns(),
  })
})

api.put('/payroll/settings', requireAdmin, (req, res) => {
  const b = body(z.object({
    number_id: z.number().int().nullable().optional(),
    template: z.string().min(1).max(4000).optional(),
    wa_template_name: z.string().max(200).optional(),
    wa_template_language: z.string().max(20).optional(),
    wa_template_params: z.string().max(500).optional(),
    reminder_phone: z.string().max(30).optional(),
    reminder_hour: z.number().int().min(0).max(23).optional(),
  }), req)
  savePayrollSettings(b)
  res.json(payrollSettings())
})

const instructor = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().max(30).default(''), active: z.boolean().default(true) })

api.post('/payroll/instructors', requireAdmin, (req, res) => {
  const b = body(instructor, req)
  if (get('SELECT id FROM instructors WHERE name = ?', b.name)) return res.status(409).json({ error: '已有同名導師' })
  run('INSERT INTO instructors (name, phone, active) VALUES (?, ?, ?)', b.name, b.phone ? normalizePhone(b.phone) : '', b.active ? 1 : 0)
  res.json({ ok: true })
})

api.patch('/payroll/instructors/:id', requireAdmin, (req, res) => {
  const b = body(instructor.partial(), req)
  const id = Number(req.params.id)
  if (b.name) run('UPDATE instructors SET name = ? WHERE id = ?', b.name, id)
  if (b.phone !== undefined) run('UPDATE instructors SET phone = ? WHERE id = ?', b.phone ? normalizePhone(b.phone) : '', id)
  if (b.active !== undefined) run('UPDATE instructors SET active = ? WHERE id = ?', b.active ? 1 : 0, id)
  res.json({ ok: true })
})

api.delete('/payroll/instructors/:id', requireAdmin, (req, res) => {
  run('DELETE FROM instructors WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

/** Read an uploaded report's columns, to choose which hold the name, amount and class count. */
api.post('/payroll/analyze', requireAdmin, (req, res) => {
  const { csv } = body(z.object({ csv: z.string().min(1).max(900_000) }), req)
  try {
    const r = analyzeReport(csv)
    res.json({ columns: r.columns, guess: r.guess, rowCount: r.rows.length, sample: r.rows.slice(0, 5) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '未能讀取報表' })
  }
})

api.post('/payroll/runs', requireAdmin, (req, res) => {
  const b = body(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/), csv: z.string().min(1).max(900_000),
    nameColumn: z.string().min(1), amountColumn: z.string().optional(), countColumn: z.string().optional(),
  }), req)
  try {
    res.json(getRun(createRun({ ...b, userId: req.user.id })))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '未能建立糧單' })
  }
})

api.get('/payroll/runs/:id', requireAdmin, (req, res) => {
  const r = getRun(Number(req.params.id))
  if (!r) return res.status(404).json({ error: '找不到糧單' })
  res.json(r)
})

/** Send now, or schedule (at = unix seconds); null cancels a schedule. */
api.post('/payroll/runs/:id/send', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { at } = body(z.object({ at: z.number().int().nullable().optional() }), req)
  const r = get<{ status: string }>('SELECT status FROM payroll_runs WHERE id = ?', id)
  if (!r) return res.status(404).json({ error: '找不到糧單' })
  if (r.status === 'sending') return res.status(409).json({ error: '正在發送中' })
  if (!payrollSettings().number_id) return res.status(400).json({ error: '請先在「發送設定」選擇用哪個 WhatsApp 號碼發送' })
  if (at === null) {
    run("UPDATE payroll_runs SET status = 'draft', scheduled_at = NULL WHERE id = ?", id)
  } else if (at && at > Date.now() / 1000) {
    run("UPDATE payroll_runs SET status = 'scheduled', scheduled_at = ? WHERE id = ?", at, id)
  } else {
    sendRun(id).catch((err) => console.error('Payroll send failed', err))
  }
  broadcast('payroll', { runId: id })
  res.json({ ok: true })
})

api.patch('/payroll/items/:id', requireAdmin, (req, res) => {
  const b = body(z.object({ message: z.string().min(1).max(4000).optional(), skip: z.boolean().optional() }), req)
  const id = Number(req.params.id)
  const item = get<{ status: string }>('SELECT status FROM payroll_items WHERE id = ?', id)
  if (!item) return res.status(404).json({ error: '找不到' })
  if (item.status === 'sent') return res.status(409).json({ error: '已發送，不能修改' })
  if (b.message) run('UPDATE payroll_items SET message = ? WHERE id = ?', b.message, id)
  if (b.skip !== undefined) run('UPDATE payroll_items SET status = ?, error = NULL WHERE id = ?', b.skip ? 'skipped' : 'pending', id)
  res.json({ ok: true })
})

/** Re-fill every unsent message from the current template (after editing the template). */
api.post('/payroll/runs/:id/rerender', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const template = payrollSettings().template
  tx(() => {
    for (const item of all<{ id: number; fields: string }>("SELECT id, fields FROM payroll_items WHERE run_id = ? AND status != 'sent'", id)) {
      run('UPDATE payroll_items SET message = ? WHERE id = ?', render(template, JSON.parse(item.fields)), item.id)
    }
  })
  res.json(getRun(id))
})

/** A notice to instructors (cover class, schedule change…), sent one by one from the payroll number. */
api.post('/payroll/notify', requireAdmin, async (req, res) => {
  const b = body(z.object({ message: z.string().trim().min(1).max(2000), ids: z.array(z.number().int()).min(1) }), req)
  const numberId = payrollSettings().number_id
  if (!numberId) return res.status(400).json({ error: '請先在「發送設定」選擇用哪個 WhatsApp 號碼發送' })
  const results: { name: string; ok: boolean; error?: string }[] = []
  for (const instructor of all<{ id: number; name: string; phone: string }>(
    `SELECT id, name, phone FROM instructors WHERE active = 1 AND id IN (${b.ids.map(() => '?').join(',')})`, ...b.ids,
  )) {
    try {
      if (!instructor.phone) throw new Error('未有電話')
      await sendToPhone(numberId, instructor.phone, b.message.replaceAll('{導師}', instructor.name), { userId: req.user.id })
      results.push({ name: instructor.name, ok: true })
    } catch (err) {
      results.push({ name: instructor.name, ok: false, error: err instanceof Error ? err.message : '發送失敗' })
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  res.json({ results })
})

api.delete('/payroll/runs/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (get("SELECT id FROM payroll_items WHERE run_id = ? AND status = 'sent'", id)) return res.status(409).json({ error: '已有糧單發出，不能刪除' })
  run('DELETE FROM payroll_runs WHERE id = ?', id)
  res.json({ ok: true })
})

// ---------- Company contact book ----------

/** Contact columns with phone hidden (NULL) while WhatsApp only gave us a LID. */
const CONTACT_COLUMNS = `ct.id, ${CONTACT_PHONE_SQL} AS phone, ct.lid, ct.name, ct.saved_name, ct.wa_name, ct.notes,
  ct.owner_id, ct.created_at, ct.updated_at, ${SOCIAL_SQL} AS social`

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
       (SELECT COALESCE(SUM(amount), 0) FROM deals d WHERE d.contact_id = ct.id AND d.stage = 'won') AS won_amount,
       (SELECT GROUP_CONCAT(tag, '、') FROM contact_tags g WHERE g.contact_id = ct.id) AS tags
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
  const visible = `(? OR NOT (${INSTRUCTOR_CHAT_SQL}))`
  const admin = req.user.role === 'admin' ? 1 : 0
  const rows = [...q].length >= 3
    ? all(`${select} WHERE ${visible} AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.ts DESC LIMIT 100`,
      admin, `"${q.replaceAll('"', '""')}"`)
    : all(`${select} WHERE ${visible} AND m.body LIKE ? ORDER BY m.ts DESC LIMIT 100`, admin, `%${q}%`)
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
