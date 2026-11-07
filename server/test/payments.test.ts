/**
 * B. FPS / PayMe purchase + verification — acceptance tests from the spec:
 * quote → screenshot → 待核實 → 核實 → 入帳 → automatic confirmation; the three exceptions
 * (金額不符, 截圖不清, 逾時) each fire with the right message; the two brands' payment
 * details never mix; nobody is told "已生效" before a teammate verifies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, fitness, pilates, staff, payments } = t
db.run("UPDATE brands SET fps_id = '111222333', fps_name = 'Fuse Pilates Ltd', payme_link = 'https://payme.example/pilates', booking_platform = 'Fuse App', booking_url = 'https://book.example/pilates' WHERE key = 'pilates'")
db.run("UPDATE brands SET fps_id = '999888777', fps_name = 'Fuse Fitness Ltd', payme_link = 'https://payme.example/fitness' WHERE key = 'fitness'")

const lastRequest = (conversationId: number) =>
  db.get<{ id: number; status: string; amount: number; ref: string; brand_id: number }>('SELECT * FROM payment_requests WHERE conversation_id = ? ORDER BY id DESC', conversationId)!

async function buyReformer8(numberId: number, phone: string) {
  const cats = await t.ask(numberId, phone, '我想買套票')
  assert.match(cats.text, /FPS／PayMe/)
  const sessions = await t.ask(numberId, phone, 'Reformer')
  assert.match(sessions.text, /8 堂 \$2,080/)
  const quoteMsg = await t.ask(numberId, phone, '8堂')
  assert.match(quoteMsg.text, /\$2,080/)
  assert.match(quoteMsg.text, /確認/)
  const details = await t.ask(numberId, phone, '確認')
  return details
}

test('full run on Fuse Pilates: quote → details → screenshot → verify → credit → confirmation', async () => {
  const details = await buyReformer8(pilates, '85292220001')
  const r = lastRequest(details.conversationId)
  assert.equal(r.status, 'awaiting_payment')
  assert.equal(r.amount, 2080)
  assert.match(details.text, /111222333/)
  assert.match(details.text, /payme\.example\/pilates/)
  assert.ok(details.text.includes(r.ref), 'reference number in the note')
  assert.ok(!details.text.includes('999888777') && !details.text.includes('payme.example/fitness'), 'no Fitness payment details')

  const shot = await t.ask(pilates, '85292220001', '', 'image')
  assert.match(shot.text, /收到你嘅付款截圖/)
  assert.ok(!/生效/.test(shot.text), 'never "已生效" before verification')
  assert.equal(lastRequest(details.conversationId).status, 'awaiting_verification')
  assert.equal(db.get<{ n: number }>('SELECT needs_human AS n FROM conversations WHERE id = ?', details.conversationId)!.n, 1)

  await assert.rejects(() => payments.credit(r.id, staff), /不能做這個動作/)
  payments.verify(r.id, staff)
  assert.equal(lastRequest(details.conversationId).status, 'verified')
  await payments.credit(r.id, staff)
  assert.equal(lastRequest(details.conversationId).status, 'notified')
  const confirmation = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC', details.conversationId)!.body
  assert.match(confirmation, /已經生效/)
  assert.match(confirmation, /Fuse App/)
  const states = db.all<{ to_status: string }>('SELECT to_status FROM payment_events WHERE request_id = ? ORDER BY id', r.id).map((e) => e.to_status)
  assert.deepEqual(states, ['quoted', 'awaiting_payment', 'awaiting_verification', 'verified', 'credited', 'notified'])
})

test('Fuse Fitness number reads only Fitness payment details', async () => {
  const details = await buyReformer8(fitness, '85292220002')
  assert.match(details.text, /999888777/)
  assert.ok(!details.text.includes('111222333') && !details.text.includes('payme.example/pilates'))
  assert.match(lastRequest(details.conversationId).ref, /^FF-/)
})

test('金額不符: returned with the right message, a new screenshot goes back to 待核實', async () => {
  const details = await buyReformer8(pilates, '85292220003')
  await t.ask(pilates, '85292220003', '', 'image')
  const r = lastRequest(details.conversationId)
  await payments.returnRequest(r.id, 'amount_mismatch', staff)
  assert.equal(lastRequest(details.conversationId).status, 'amount_mismatch')
  const msg = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC', details.conversationId)!.body
  assert.match(msg, /金額.*唔一致/)
  assert.match(msg, /\$2,080/)
  await t.ask(pilates, '85292220003', '', 'image')
  assert.equal(lastRequest(details.conversationId).status, 'awaiting_verification')
})

test('截圖不清: returned with a request for a clearer screenshot', async () => {
  const details = await buyReformer8(pilates, '85292220004')
  await t.ask(pilates, '85292220004', '', 'image')
  const r = lastRequest(details.conversationId)
  await payments.returnRequest(r.id, 'unclear', staff)
  const msg = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC', details.conversationId)!.body
  assert.match(msg, /截圖唔太清楚/)
  assert.equal(lastRequest(details.conversationId).status, 'unclear')
})

test('逾時未付: one reminder after 24 h, cancelled 48 h later, team told', async () => {
  const details = await buyReformer8(pilates, '85292220005')
  const r = lastRequest(details.conversationId)
  db.run('UPDATE payment_requests SET updated_at = unixepoch() - 25 * 3600 WHERE id = ?', r.id)
  await payments.paymentTimers()
  assert.equal(lastRequest(details.conversationId).status, 'overdue')
  const reminder = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC', details.conversationId)!.body
  assert.match(reminder, /仲未收到付款截圖/)
  await payments.paymentTimers()
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND body LIKE '%仲未收到付款截圖%'", details.conversationId)!.c, 1, 'only one reminder')
  db.run('UPDATE payment_requests SET reminded_at = unixepoch() - 49 * 3600 WHERE id = ?', r.id)
  await payments.paymentTimers()
  assert.equal(lastRequest(details.conversationId).status, 'cancelled')
  assert.equal(db.get<{ n: number }>('SELECT needs_human AS n FROM conversations WHERE id = ?', details.conversationId)!.n, 1)
})

test('discount whose price is not listed: no computed price, a teammate quotes', async () => {
  const phone = '85292220006'
  const s = t.say(pilates, phone, 'hi')
  const contact = db.get<{ contact_id: number }>('SELECT contact_id FROM conversations WHERE id = ?', s.conversationId)!.contact_id
  db.run("INSERT INTO trials (contact_id, conversation_id, class_at, class_name, source) VALUES (?, ?, unixepoch() - 3 * 3600, 'Reformer 1 堂', 'staff')", contact, s.conversationId)
  await new Promise((r) => setTimeout(r, 200))
  await t.ask(pilates, phone, '試完堂想買套票')
  await t.ask(pilates, phone, '1')
  const r1 = await t.ask(pilates, phone, '12堂')
  assert.match(r1.text, /原價 \$3,000/)
  assert.match(r1.text, /以同事確認為準/)
  assert.ok(!/\$2,850/.test(r1.text), 'never computes 95 折')
  const req = lastRequest(s.conversationId)
  assert.equal(req.status, 'pending_quote')
  await payments.quote(req.id, 2850, staff)
  assert.equal(lastRequest(s.conversationId).status, 'awaiting_payment')
  const msg = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC', s.conversationId)!.body
  assert.match(msg, /\$2,850/)
})

test('complaint during a purchase: stops and goes to a person; credit still needs verification', async () => {
  const details = await buyReformer8(pilates, '85292220007')
  const r = await t.ask(pilates, '85292220007', '我要投訴你哋')
  assert.equal(db.get<{ n: number }>('SELECT needs_human AS n FROM conversations WHERE id = ?', r.conversationId)!.n, 1)
  const req = lastRequest(details.conversationId)
  await assert.rejects(() => payments.credit(req.id, staff))
})

test('no payment details set: no invented account, a person takes over', async () => {
  db.run("UPDATE brands SET fps_id = '', payme_link = '' WHERE key = 'fitness'")
  const details = await buyReformer8(fitness, '85292220008')
  assert.ok(!/FPS 轉數快：|payme\.example/.test(details.text))
  const ev = db.get<{ body: string }>("SELECT body FROM events WHERE conversation_id = ? AND kind = 'ai_handoff' ORDER BY id DESC", details.conversationId)!
  assert.match(ev.body, /收款資料未設定/)
})
