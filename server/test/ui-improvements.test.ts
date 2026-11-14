/**
 * UI 改進版 v1: (A) the sync banner counts saved names that actually changed, and the
 * settle-wait helper reports once contact events go quiet; (C) listConversations exposes
 * waiting_since with the same definition as automation.waitingCustomers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, inbox } = t
const wa = await import('../src/whatsapp.js')

test('resolveContact counts a saved-name update only when the value actually changes', () => {
  const pn = '85291112222'
  const before = inbox.savedNameUpdateCount()
  inbox.resolveContact({ pn }, { saved: '電話簿阿明' })
  assert.equal(inbox.savedNameUpdateCount(), before + 1, 'first saved name counts')
  inbox.resolveContact({ pn }, { saved: '電話簿阿明' })
  assert.equal(inbox.savedNameUpdateCount(), before + 1, 'same name again does not count')
  inbox.resolveContact({ pn }, { saved: '明哥' })
  assert.equal(inbox.savedNameUpdateCount(), before + 2, 'a changed name counts again')
  inbox.resolveContact({ pn }, { wa: '客人檔案名' })
  assert.equal(inbox.savedNameUpdateCount(), before + 2, 'profile-name updates never count')
})

test('waitForSavedNamesToSettle waits for quiescence, and returns at once when the scale is 0', async () => {
  let value = 0
  const bump = setInterval(() => { value++ }, 15)
  setTimeout(() => clearInterval(bump), 120)
  const started = Date.now()
  await wa.waitForSavedNamesToSettle(() => value, { pollMs: 20, quietMs: 60, capMs: 2000 })
  assert.ok(Date.now() - started < 2000, 'settles well before the hard cap')
  assert.ok(value > 0, 'the counter really moved while waiting')

  process.env.BATON_HISTORY_DELAY_SCALE = '0'
  try {
    const t0 = Date.now()
    await wa.waitForSavedNamesToSettle(() => 42)
    assert.ok(Date.now() - t0 < 100, 'scale 0 means no waiting at all')
  } finally {
    delete process.env.BATON_HISTORY_DELAY_SCALE
  }
})

// ---------- waiting_since ----------

const suggest = Number(db.run(
  "INSERT INTO numbers (label, phone, status, channel, reply_mode, brand_id) VALUES ('建議模式測試', '85290001111', 'connected', 'wa_web', 'suggest', ?)",
  t.brandId('fitness'),
).lastInsertRowid)

const now = Math.floor(Date.now() / 1000)
function store(numberId: number, phone: string, fromMe: boolean, ts: number, body: string) {
  return inbox.storeMessage({
    numberId, jid: `${phone}@s.whatsapp.net`, contact: { pn: phone }, waName: '測試客',
    waId: `w-${phone}-${ts}-${fromMe ? 'o' : 'i'}`, fromMe, type: 'text', body, ts, live: false,
  })!
}
const rowOf = (conversationId: number, view = 'all') =>
  inbox.listConversations({ view, userId: t.staff, admin: true }).find((r: any) => r.id === conversationId)

test('waiting_since: customer spoke last on a suggest-mode number', () => {
  const s = store(suggest, '85293334444', false, now, '你好')
  assert.equal(rowOf(s.conversationId).waiting_since, now)
})

test('waiting_since: null once the team has replied', () => {
  const s = store(suggest, '85293334444', true, now + 60, '你好，請問想問邊款堂？')
  assert.equal(rowOf(s.conversationId).waiting_since, null)
})

test('waiting_since: null while the AI is handling an auto-mode number, set once it hands over', () => {
  const s = store(t.fitness, '85295556666', false, now, '想試堂')
  assert.equal(rowOf(s.conversationId).waiting_since, null, 'auto mode + AI active is not waiting on a human')
  db.run('UPDATE conversations SET needs_human = 1 WHERE id = ?', s.conversationId)
  assert.equal(rowOf(s.conversationId).waiting_since, now, 'handed to a human: now waiting')
})

test('waiting_since: null for a closed conversation', () => {
  const s = store(suggest, '85297778888', false, now, '唔該')
  db.run("UPDATE conversations SET status = 'closed' WHERE id = ?", s.conversationId)
  assert.equal(rowOf(s.conversationId, 'closed').waiting_since, null)
})
