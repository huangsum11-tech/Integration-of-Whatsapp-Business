/**
 * TASK-9: "同步歷史對話" imports an Instagram account's pre-existing DMs through Meta's
 * conversations API. Idempotent (dedupe by Meta message id), stored as history: no unread
 * badges, no AI replies, no alerts, nothing sent. Both routes are covered — EAA through
 * graph.facebook.com (via the Page), IGAA through graph.instagram.com.
 * Meta is mocked with paginated responses; every person and message here is fictional.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db } = t
const meta = await import('../src/meta.js')

const IGAA = 'IGAAtesttoken0123456789abcdef'
const EAA_PAGE = 'EAApagetoken0123456789abcdef'
const IG_ID = '17841404039939942'
const PAGE_ID = '1000000000000001'
const IGAA_ID = '17841400000000001'

type Call = { url: string; token: string }
let calls: Call[] = []
const realFetch = globalThis.fetch
function mock(handler: (url: string) => [number, unknown]) {
  calls = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace('Bearer ', '')
    calls.push({ url, token })
    const [status, json] = handler(url)
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

const hosts = () => [...new Set(calls.map((c) => new URL(c.url).host))]

const addNumber = (label: string, config: object) => Number(db.run(
  "INSERT INTO numbers (label, channel, config, status, reply_mode) VALUES (?, 'instagram', ?, 'connected', 'off')", label, JSON.stringify(config),
).lastInsertRowid)
const fbNumber = addNumber('IG via Facebook', { igUserId: IG_ID, pageId: PAGE_ID, accessToken: EAA_PAGE, host: 'facebook', expiresAt: 0 })
const igNumber = addNumber('IG via Instagram Login', { igUserId: IGAA_ID, accessToken: IGAA, host: 'instagram' })

// ---------- Fictional Facebook-route data, paginated on both edges ----------

const AMY = { id: '555101', username: 'amy.fit' }
const BEN = { id: '555102', username: 'benny' }
const convA = { id: 'conv-a', participants: { data: [{ id: IG_ID, username: 'fusefitnesshk' }, AMY] } }
const convB = { id: 'conv-b', participants: { data: [{ id: IG_ID, username: 'fusefitnesshk' }, BEN] } }
const m1 = {
  id: 'mid-a1', created_time: '2026-11-10T10:00:00+0000', from: AMY,
  attachments: { data: [{ id: 'att-1', mime_type: 'image/jpeg', image_data: { url: 'https://example.invalid/a.jpg' } }] },
}
const m2 = {
  id: 'mid-a2', created_time: '2026-11-10T10:01:00+0000', from: { id: IG_ID, username: 'fusefitnesshk' },
  to: { data: [AMY] }, message: '你好！多謝你查詢 😊',
}
const m3 = { id: 'mid-a3', created_time: '2026-11-10T10:03:00+0000', from: AMY, message: '想問試堂幾錢？' }
const m4 = { id: 'mid-b1', created_time: '2026-11-09T09:00:00+0000', from: BEN, message: 'Hello, 請問觀塘有冇堂？' }

function fbData(url: string): [number, unknown] {
  if (url.includes('/conversations?') && url.includes('cursor=c2')) return [200, { data: [convB] }]
  if (url.includes('/conversations?')) return [200, { data: [convA], paging: { next: 'https://graph.facebook.com/v25.0/x/conversations?cursor=c2' } }]
  if (url.includes('/conv-a/messages') && url.includes('cursor=p2')) return [200, { data: [m1] }]
  if (url.includes('/conv-a/messages')) return [200, { data: [m3, m2], paging: { next: 'https://graph.facebook.com/v25.0/conv-a/messages?cursor=p2' } }]
  if (url.includes('/conv-b/messages')) return [200, { data: [m4] }]
  return [400, { error: { message: `unmocked ${url}` } }]
}

const countMessages = (numberId: number) => db.get<{ c: number }>(
  'SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.number_id = ?', numberId,
)!.c

test('first sync (EAA route): imports every conversation and message, closed and silent', async () => {
  let customerEvents = 0
  let teamEvents = 0
  t.inbox.inboxEvents.on('customer-message', () => customerEvents++)
  t.inbox.inboxEvents.on('team-message', () => teamEvents++)

  mock(fbData)
  const summary = await meta.syncInstagramHistory(fbNumber)
  assert.deepEqual(summary, { conversations: 2, messages: 4, skipped: 0 })
  assert.deepEqual(hosts(), ['graph.facebook.com'], 'an EAA account is only read on graph.facebook.com')
  assert.ok(calls.every((c) => c.token === EAA_PAGE))
  assert.match(calls[0].url, new RegExp(`/${PAGE_ID}/conversations\\?platform=instagram`), 'the list is read through the Page')

  // Filed through the normal store: contact keyed ig:<igsid>, "@username" as the display name.
  const contact = db.get<{ phone: string; wa_name: string | null }>(
    "SELECT phone, wa_name FROM contacts WHERE phone = 'ig:555101'",
  )
  assert.deepEqual({ ...contact }, { phone: 'ig:555101', wa_name: '@amy.fit' })

  const conv = db.get<{ status: string; unread: number; last_message_at: number }>(
    'SELECT status, unread, last_message_at FROM conversations WHERE number_id = ? AND jid = ?', fbNumber, '555101@instagram',
  )!
  assert.equal(conv.status, 'closed', 'a conversation created by history sync is closed')
  assert.equal(conv.unread, 0, 'history must not raise an unread badge')
  assert.equal(conv.last_message_at, Math.floor(Date.parse(m3.created_time) / 1000))

  // Original Meta timestamps and directions are kept.
  const rows = db.all<{ wa_id: string; from_me: number; type: string; ts: number; media_mime: string | null; media_path: string | null }>(
    `SELECT m.wa_id, m.from_me, m.type, m.ts, m.media_mime, m.media_path FROM messages m
     JOIN conversations c ON c.id = m.conversation_id WHERE c.number_id = ? ORDER BY m.ts`, fbNumber,
  )
  assert.deepEqual(rows.map((r) => [r.wa_id, r.from_me, r.type, r.ts]), [
    ['mid-b1', 0, 'text', Math.floor(Date.parse(m4.created_time) / 1000)],
    ['mid-a1', 0, 'image', Math.floor(Date.parse(m1.created_time) / 1000)],
    ['mid-a2', 1, 'text', Math.floor(Date.parse(m2.created_time) / 1000)],
    ['mid-a3', 0, 'text', Math.floor(Date.parse(m3.created_time) / 1000)],
  ])
  const photo = rows.find((r) => r.wa_id === 'mid-a1')!
  assert.equal(photo.media_mime, 'image/jpeg', 'attachment metadata is kept')
  assert.equal(photo.media_path, null, 'media itself is not downloaded')

  // Silence: no inbox events (so no AI reply, no flow, no waiting alert can fire),
  // no events written, and nothing extra appears even after the auto-reply would have run.
  assert.equal(customerEvents, 0)
  assert.equal(teamEvents, 0)
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events')!.c, 0)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(countMessages(fbNumber), 4)
  assert.equal(db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.number_id = ? AND m.from_me = 1', fbNumber,
  )!.c, 1, 'the only outgoing message is the historical one')
})

test('re-running the sync imports nothing new and counts the duplicates it skipped', async () => {
  mock(fbData)
  const summary = await meta.syncInstagramHistory(fbNumber)
  assert.deepEqual(summary, { conversations: 0, messages: 0, skipped: 4 })
  assert.equal(countMessages(fbNumber), 4)
  const conv = db.get<{ status: string }>(
    'SELECT status FROM conversations WHERE number_id = ? AND jid = ?', fbNumber, '555101@instagram',
  )!
  assert.equal(conv.status, 'closed')
})

test('IGAA route: the same sync reads graph.instagram.com by the Instagram user ID', async () => {
  const CAT = { id: '555103', username: 'catcat' }
  mock((url) => {
    if (!url.startsWith('https://graph.instagram.com/')) return [400, { error: { message: 'wrong host' } }]
    if (url.includes('/conversations?')) return [200, { data: [{ id: 'conv-c', participants: { data: [{ id: IGAA_ID }, CAT] } }] }]
    if (url.includes('/conv-c/messages')) return [200, { data: [{ id: 'mid-c1', created_time: '2026-11-08T08:30:00+0000', from: CAT, message: 'Hi' }] }]
    return [400, { error: { message: `unmocked ${url}` } }]
  })
  const summary = await meta.syncInstagramHistory(igNumber)
  assert.deepEqual(summary, { conversations: 1, messages: 1, skipped: 0 })
  assert.deepEqual(hosts(), ['graph.instagram.com'])
  assert.match(calls[0].url, new RegExp(`/${IGAA_ID}/conversations\\?platform=instagram`))
  assert.equal(calls[0].token, IGAA)
  assert.equal(db.get<{ status: string }>(
    'SELECT status FROM conversations WHERE number_id = ? AND jid = ?', igNumber, '555103@instagram',
  )!.status, 'closed')
})

test('a Meta error aborts the sync and surfaces Meta\'s wording', async () => {
  mock(() => [400, { error: { message: '(#100) Tried accessing nonexisting field (conversations)' } }])
  await assert.rejects(meta.syncInstagramHistory(fbNumber), /Meta API 錯誤：\(#100\) Tried accessing nonexisting field/)
})
