/**
 * Test harness: a throwaway database, the two Fuse brands, and demo WhatsApp numbers whose
 * replies are stored instead of sent. Customers "say" things and the real auto-reply runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function setup() {
  process.env.BATON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'))
  process.env.BATON_AI_DELAY_MS = '10'
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'XAI_API_KEY']) delete process.env[k]
  const db = await import('../src/db.js')
  const inbox = await import('../src/inbox.js')
  const brands = await import('../src/brands.js')
  await import('../src/autoreply.js')
  const automation = await import('../src/automation.js')
  const payments = await import('../src/payments.js')
  const flows = await import('../src/flows.js')
  brands.seedCatalogue()
  const brandId = (key: string) => db.get<{ id: number }>('SELECT id FROM brands WHERE key = ?', key)!.id
  const number = (label: string, phone: string, brand: string) => Number(db.run(
    "INSERT INTO numbers (label, phone, status, demo, reply_mode, brand_id) VALUES (?, ?, 'demo', 1, 'auto', ?)", label, phone, brandId(brand),
  ).lastInsertRowid)
  const fitness = number('Fuse Fitness', '85263388653', 'fitness')
  const pilates = number('Fuse Pilates', '85254054224', 'pilates')
  const staff = Number(db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Karen', 'k@test', 'x', 'admin')").lastInsertRowid)

  let seq = 0
  /** The customer sends a message; returns the conversation id and the message id. */
  function say(numberId: number, phone: string, body: string, type: 'text' | 'image' = 'text') {
    const stored = inbox.storeMessage({
      numberId, jid: `${phone}@s.whatsapp.net`, contact: { pn: phone }, waName: `客人${phone.slice(-4)}`,
      waId: `t-${Date.now()}-${seq++}`, fromMe: false, type, body, ts: Math.floor(Date.now() / 1000), live: true,
    })!
    return stored
  }

  /** Wait until the team side has answered after the given message, and return what it said. */
  async function reply(conversationId: number, afterMessageId: number, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const out = db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 AND id > ? ORDER BY id', conversationId, afterMessageId)
      const handed = db.get('SELECT 1 FROM events WHERE conversation_id = ? AND kind = \'ai_handoff\' AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE conversation_id = ? AND kind = \'test_mark\')', conversationId, conversationId)
      if (out.length) { await new Promise((r) => setTimeout(r, 60)); return db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 AND id > ? ORDER BY id', conversationId, afterMessageId).map((m) => m.body).join('\n---\n') }
      if (Date.now() > end) return handed ? '(handoff)' : ''
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Say something and wait for the answer. */
  async function ask(numberId: number, phone: string, body: string, type: 'text' | 'image' = 'text') {
    const s = say(numberId, phone, body, type)
    db.run("INSERT INTO events (conversation_id, kind) VALUES (?, 'test_mark')", s.conversationId)
    return { ...s, text: await reply(s.conversationId, s.messageId) }
  }

  return { db, inbox, brands, automation, payments, flows, fitness, pilates, staff, brandId, say, ask }
}

/** "11月12日 晚上7點" for a day N days from now, in Hong Kong time. */
export function hkDayText(daysAhead: number, time = '晚上7點') {
  const d = new Date(Date.now() + daysAhead * 86400_000 + 8 * 3600_000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${time}`
}
