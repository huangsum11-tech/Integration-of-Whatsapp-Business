/**
 * TASK-5: the 「同真人講」 quick-reply button on the AI's WhatsApp Cloud API replies.
 * Sending (payload, which replies carry it), receiving (button tap or the four typed characters
 * hand the chat to a person) and duplicate protection. Numbers are demo numbers: replies are
 * stored, nothing reaches Meta.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, say, ask, brandId, staff } = t
const meta = await import('../src/meta.js')
const autoreply = await import('../src/autoreply.js')
const channels = await import('../src/channels.js')

const cloud = Number(db.run(
  `INSERT INTO numbers (label, phone, status, demo, reply_mode, brand_id, channel, config)
   VALUES ('Cloud', '85263388000', 'connected', 1, 'auto', ?, 'wa_cloud', '{"phoneNumberId":"PNID-1","accessToken":"x"}')`,
  brandId('fitness'),
).lastInsertRowid)
db.run("INSERT INTO knowledge (category, title, body, keywords) VALUES ('faq', '防滑襪', '上 Reformer 堂要著防滑襪 😊', '防滑襪')")
db.run("INSERT INTO settings (key, value) VALUES ('handoff_message', '收到！同事會盡快回覆你') ON CONFLICT (key) DO UPDATE SET value = excluded.value")

let phoneSeq = 0
const newPhone = () => `8529100${String(phoneSeq++).padStart(4, '0')}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) return false
    await sleep(20)
  }
  return true
}

// Rows come back with a null prototype; copy them so deepEqual compares plain objects.
const conversation = (id: number) => ({ ...db.get<{ needs_human: number; ai_paused: number }>('SELECT needs_human, ai_paused FROM conversations WHERE id = ?', id)! })
const outgoing = (id: number) => db.all<{ body: string; buttons: string | null }>('SELECT body, buttons FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id', id)
const requests = (id: number) => db.get<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE conversation_id = ? AND kind = 'ai_handoff' AND body = ?", id, autoreply.HUMAN_REQUEST_EVENT)!.c
const repeats = (id: number) => db.get<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE conversation_id = ? AND kind = 'ai_handoff_repeat'", id)!.c

/** A Cloud API webhook delivery with one message, as Meta sends it. */
function webhook(phone: string, message: Record<string, unknown>) {
  meta.handleWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PNID-1' },
      contacts: [{ wa_id: phone, profile: { name: 'Test Customer' } }],
      messages: [{ from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    } }] }],
  })
}
const tap = (phone: string, id: string, title: string = meta.HUMAN_BUTTON.title) =>
  webhook(phone, { id, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: meta.HUMAN_BUTTON.id, title } } })

// ---------- Sending ----------

test('payload: one quick-reply button 「同真人講」 with id handoff_human, in WhatsApp\'s interactive shape', () => {
  assert.deepEqual(meta.cloudButtonPayload('85291234567', '你好', [meta.HUMAN_BUTTON]), {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '85291234567', type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '你好' },
      action: { buttons: [{ type: 'reply', reply: { id: 'handoff_human', title: '💬 搵真人同事' } }] },
    },
  })
  // WhatsApp's limits: button title up to 20 characters, id up to 256.
  assert.ok([...meta.HUMAN_BUTTON.title].length <= 20)
  assert.ok(meta.HUMAN_BUTTON.id.length <= 256)
})

test('FAQ answer on a Cloud API number carries the button', async () => {
  const r = await ask(cloud, newPhone(), '使唔使著防滑襪？')
  assert.equal(r.text, '上 Reformer 堂要著防滑襪 😊')
  assert.deepEqual(JSON.parse(outgoing(r.conversationId).at(-1)!.buttons!), [meta.HUMAN_BUTTON.title])
})

test('no button: QR-linked WhatsApp number, guided flow step, teammate reply, text over 1024 characters', async () => {
  const qr = await ask(t.fitness, newPhone(), '使唔使著防滑襪？')
  assert.equal(outgoing(qr.conversationId).at(-1)!.buttons, null)

  const flow = await ask(cloud, newPhone(), '我想試堂')
  assert.ok(flow.text, 'the trial flow answered')
  assert.ok(outgoing(flow.conversationId).every((m) => m.buttons === null))

  await channels.sendReply(flow.conversationId, '同事手打回覆', { userId: staff })
  assert.equal(outgoing(flow.conversationId).at(-1)!.buttons, null)

  await channels.sendReply(flow.conversationId, '長'.repeat(1025), { userId: null, aiAuto: true, humanButton: true })
  assert.equal(outgoing(flow.conversationId).at(-1)!.buttons, null)
  await channels.sendReply(flow.conversationId, '短', { userId: null, aiAuto: true, humanButton: true })
  assert.deepEqual(JSON.parse(outgoing(flow.conversationId).at(-1)!.buttons!), [meta.HUMAN_BUTTON.title])
})

// ---------- Receiving ----------

test('button tap: needs_human and ai_paused set, guided flow stopped, handoff message sent once without the button', async () => {
  const phone = newPhone()
  const start = await ask(cloud, phone, '我想試堂')
  const id = start.conversationId
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM flows WHERE conversation_id = ? AND status = 'active'", id)!.c, 1)
  const before = outgoing(id).length

  // Recognised by the button id even if the title Meta sends back differs.
  tap(phone, 'wamid.tap-1', 'Talk to a person')
  assert.ok(await until(() => outgoing(id).length === before + 1))
  assert.deepEqual(conversation(id), { needs_human: 1, ai_paused: 1 })
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM flows WHERE conversation_id = ? AND status = 'active'", id)!.c, 0)
  assert.equal(db.get<{ status: string }>('SELECT status FROM flows WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', id)!.status, 'aborted')
  const handoff = outgoing(id).at(-1)!
  assert.equal(handoff.body, '收到！同事會盡快回覆你')
  assert.equal(handoff.buttons, null)
  assert.equal(requests(id), 1)
})

test('duplicates: a second tap and the typed words are only noted; Meta resending the same webhook changes nothing', async () => {
  const phone = newPhone()
  const first = say(cloud, phone, '你好')
  const id = first.conversationId
  tap(phone, 'wamid.dup-1')
  assert.ok(await until(() => requests(id) === 1))
  const sent = outgoing(id).length

  tap(phone, 'wamid.dup-1') // same message id: Meta retrying the delivery
  tap(phone, 'wamid.dup-2') // a second tap
  say(cloud, phone, '同真人講') // typed
  await sleep(300)
  assert.equal(requests(id), 1)
  assert.equal(repeats(id), 2, 'the second tap and the typed words are noted, the retry is not')
  assert.equal(outgoing(id).length, sent)
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND wa_id = 'wamid.dup-1'", id)!.c, 1)
})

test('after a teammate replies, asking again hands over again', async () => {
  const phone = newPhone()
  const id = say(cloud, phone, '你好').conversationId
  tap(phone, 'wamid.again-1')
  assert.ok(await until(() => requests(id) === 1))
  await channels.sendReply(id, '你好，我係 Karen', { userId: staff })
  assert.ok(await until(() => conversation(id).needs_human === 0, 5000))
  tap(phone, 'wamid.again-2')
  assert.ok(await until(() => requests(id) === 2))
  assert.equal(conversation(id).needs_human, 1)
})

test('typed exactly 「同真人講」 (spaces or a final ！ allowed) hands over like the button', async () => {
  for (const typed of ['同真人講', ' 同真人講 ', '同真人講！', '搵真人同事', '💬 搵真人同事']) {
    const s = say(cloud, newPhone(), typed)
    assert.ok(await until(() => requests(s.conversationId) === 1), typed)
    assert.deepEqual(conversation(s.conversationId), { needs_human: 1, ai_paused: 1 })
  }
})

test('no false trigger: sentences containing the words, other text, and QR-linked numbers', async () => {
  for (const text of ['我唔想同真人講', '同真人講嘢好麻煩', '可唔可以同真人講？', '真人', '']) {
    assert.equal(autoreply.isHumanRequest(text), false, text)
  }
  const s = say(cloud, newPhone(), '我唔想同真人講')
  const qr = say(t.fitness, newPhone(), '同真人講')
  await sleep(400)
  assert.equal(requests(s.conversationId), 0)
  assert.equal(requests(qr.conversationId), 0)
  assert.equal(conversation(qr.conversationId).ai_paused, 0)
})

test("'suggest' mode: the request goes to the team's queue, and nothing is sent to the customer", async () => {
  db.run("UPDATE numbers SET reply_mode = 'suggest' WHERE id = ?", cloud)
  try {
    const s = say(cloud, newPhone(), '同真人講')
    assert.ok(await until(() => requests(s.conversationId) === 1))
    assert.deepEqual(conversation(s.conversationId), { needs_human: 1, ai_paused: 1 })
    assert.equal(outgoing(s.conversationId).length, 0)
  } finally {
    db.run("UPDATE numbers SET reply_mode = 'auto' WHERE id = ?", cloud)
  }
})

test('a button sent before the id changed (baton_human) still hands over', async () => {
  const phone = newPhone()
  const id = say(cloud, phone, '你好').conversationId
  webhook(phone, { id: 'wamid.legacy-1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'baton_human', title: 'Talk to a person' } } })
  assert.ok(await until(() => requests(id) === 1))
  assert.deepEqual(conversation(id), { needs_human: 1, ai_paused: 1 })
})
