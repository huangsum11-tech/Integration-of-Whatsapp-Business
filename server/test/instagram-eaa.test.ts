/**
 * TASK-8: Instagram with a Facebook-platform (EAA) token goes through graph.facebook.com;
 * the Instagram Login (IGAA) route on graph.instagram.com is unchanged.
 * Meta is mocked: every request is recorded and answered from a small table.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db } = t
const meta = await import('../src/meta.js')
const tokens = await import('../src/tokens.js')

const IGAA = 'IGAAtesttoken0123456789abcdef'
const EAA_USER = 'EAAusertoken0123456789abcdef'
const EAA_PAGE = 'EAApagetoken0123456789abcdef'
const IG_ID = '17841404039939942'
const PAGE_ID = '1000000000000001'

type Call = { method: string; url: string; token: string; body: unknown }
let calls: Call[] = []
let routes: [RegExp, number, unknown][] = []
const realFetch = globalThis.fetch
function mock(table: [RegExp, number, unknown][]) {
  calls = []
  routes = table
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace('Bearer ', '')
    calls.push({ method: init?.method ?? 'GET', url, token, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const hit = routes.find(([re]) => re.test(url))
    const [status, json] = hit ? [hit[1], hit[2]] : [400, { error: { message: `unmocked ${url}` } }]
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

const hosts = () => [...new Set(calls.map((c) => new URL(c.url).host))]

// ---------- Verifying ----------

test('IGAA token: verified on graph.instagram.com/me, as before', async () => {
  mock([[/graph\.instagram\.com\/v[\d.]+\/me\?/, 200, { user_id: IG_ID, username: 'fusefitnesshk' }]])
  const info = await meta.verifyInstagram(IGAA)
  assert.equal(info.igUserId, IG_ID)
  assert.equal(info.username, 'fusefitnesshk')
  assert.equal(info.host, 'instagram')
  assert.deepEqual(hosts(), ['graph.instagram.com'])
})

test('EAA user/system-user token: account found through its Page on graph.facebook.com, Page token kept, expiry read', async () => {
  mock([
    [/\/me\/accounts\?/, 200, { data: [
      { id: '999', name: 'Other page', access_token: 'EAAother', },
      { id: PAGE_ID, name: 'Fuse Fitness', access_token: EAA_PAGE, instagram_business_account: { id: IG_ID, username: 'fusefitnesshk' } },
    ] }],
    [/\/debug_token\?/, 200, { data: { is_valid: true, expires_at: 0, type: 'PAGE' } }],
  ])
  const info = await meta.verifyInstagram(EAA_USER)
  assert.deepEqual({ ...info }, { igUserId: IG_ID, username: 'fusefitnesshk', pageId: PAGE_ID, accessToken: EAA_PAGE, host: 'facebook', expiresAt: 0, tokenType: 'PAGE' })
  assert.deepEqual(hosts(), ['graph.facebook.com'], 'an EAA token is never sent to graph.instagram.com')
  assert.equal(calls[0].token, EAA_USER)
})

test('EAA token scoped to the Instagram account: read by the given ID; user-token expiry (about 60 days) kept', async () => {
  const in60 = Math.floor(Date.now() / 1000) + 60 * 86400
  mock([
    [/\/me\/accounts\?/, 400, { error: { message: 'no pages' } }],
    [/\/me\?fields=id,name,instagram_business_account/, 200, { id: IG_ID }],
    [new RegExp(`/${IG_ID}\\?fields=id,username`), 200, { id: IG_ID, username: 'fusefitnesshk' }],
    [/\/debug_token\?/, 200, { data: { is_valid: true, expires_at: in60, type: 'USER' } }],
  ])
  const info = await meta.verifyInstagram(`  ${EAA_USER}  `, IG_ID)
  assert.equal(info.igUserId, IG_ID)
  assert.equal(info.pageId, undefined)
  assert.equal(info.accessToken, EAA_USER, 'the pasted token is trimmed')
  assert.equal(info.expiresAt, in60)
  assert.equal(info.tokenType, 'USER')
  assert.deepEqual(hosts(), ['graph.facebook.com'])
})

test('EAA token: several Instagram accounts and no ID asks for the ID; nothing found says so; expiry unknown is fine', async () => {
  mock([[/\/me\/accounts\?/, 200, { data: [
    { id: '1', access_token: 'EAA1', instagram_business_account: { id: '178411' } },
    { id: '2', access_token: 'EAA2', instagram_business_account: { id: '178412' } },
  ] }]])
  await assert.rejects(meta.verifyInstagram(EAA_USER), /多個 Instagram 帳戶/)

  mock([[/\/me\/accounts\?/, 200, { data: [] }], [/\/me\?/, 200, { id: '5' }]])
  await assert.rejects(meta.verifyInstagram(EAA_USER), /搵唔到 Instagram 帳戶/)

  mock([
    [/\/me\/accounts\?/, 200, { data: [{ id: PAGE_ID, access_token: EAA_PAGE, instagram_business_account: { id: IG_ID } }] }],
    [/\/debug_token\?/, 400, { error: { message: 'needs app token' } }],
  ])
  const info = await meta.verifyInstagram(EAA_USER, IG_ID)
  assert.equal(info.pageId, PAGE_ID)
  assert.equal(info.expiresAt, undefined)
})

// ---------- Sending, subscribing, refreshing ----------

const addNumber = (label: string, config: object) => Number(db.run(
  "INSERT INTO numbers (label, channel, config, status, reply_mode) VALUES (?, 'instagram', ?, 'connected', 'off')", label, JSON.stringify(config),
).lastInsertRowid)
const fbNumber = addNumber('IG via Facebook', { igUserId: IG_ID, pageId: PAGE_ID, accessToken: EAA_PAGE, host: 'facebook', expiresAt: 0 })
const igNumber = addNumber('IG via Instagram Login', { igUserId: '17841400000000001', accessToken: IGAA, refreshedAt: 0 })

function conversationWithCustomer(numberId: number, igsid: string) {
  return t.inbox.storeMessage({
    numberId, jid: `${igsid}@instagram`, contact: { ig: igsid }, waId: `mid-${igsid}`, fromMe: false, type: 'text', body: 'hi',
    ts: Math.floor(Date.now() / 1000), live: false,
  })!.conversationId
}

test('sending: Facebook route posts to graph.facebook.com/{page}/messages with the Page token; IGAA route unchanged', async () => {
  mock([[/\/messages$/, 200, { message_id: 'mid.out' }]])
  const fbConv = conversationWithCustomer(fbNumber, '555001')
  assert.equal(await meta.sendInstagramText(fbNumber, fbConv, '555001@instagram', '你好'), 'mid.out')
  assert.equal(calls.at(-1)!.url, `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? 'v25.0'}/${PAGE_ID}/messages`)
  assert.equal(calls.at(-1)!.token, EAA_PAGE)
  assert.deepEqual(calls.at(-1)!.body, { recipient: { id: '555001' }, message: { text: '你好' } })

  const igConv = conversationWithCustomer(igNumber, '555002')
  await meta.sendInstagramText(igNumber, igConv, '555002@instagram', '你好')
  assert.match(calls.at(-1)!.url, /^https:\/\/graph\.instagram\.com\/v[\d.]+\/17841400000000001\/messages$/)
  assert.equal(calls.at(-1)!.token, IGAA)
})

test('comments: private reply and public reply follow the account\'s host', async () => {
  mock([[/\/messages$/, 200, { message_id: 'm' }], [/\/replies$/, 200, { id: 'r' }]])
  await meta.sendInstagramPrivateReply(fbNumber, 'c1', '已私訊你')
  await meta.replyToInstagramComment(fbNumber, 'c1', '已私訊你 😊')
  await meta.replyToInstagramComment(igNumber, 'c2', '已私訊你 😊')
  assert.deepEqual(calls.map((c) => new URL(c.url).host + new URL(c.url).pathname.replace(/^\/v[\d.]+/, '')), [
    `graph.facebook.com/${PAGE_ID}/messages`,
    'graph.facebook.com/c1/replies',
    'graph.instagram.com/c2/replies',
  ])
  assert.deepEqual(calls[0].body, { recipient: { comment_id: 'c1' }, message: { text: '已私訊你' } })
})

test('webhook subscription: Facebook route uses graph.facebook.com/{igUserId}/subscribed_apps, Page as fallback', async () => {
  mock([[/\/subscribed_apps$/, 200, { success: true }]])
  await meta.subscribeWebhooks('instagram', { igUserId: IG_ID, pageId: PAGE_ID, accessToken: EAA_PAGE, host: 'facebook' })
  assert.match(calls[0].url, new RegExp(`^https://graph\\.facebook\\.com/v[\\d.]+/${IG_ID}/subscribed_apps$`))
  assert.deepEqual(calls[0].body, { subscribed_fields: 'messages,comments' })

  mock([[new RegExp(`/${IG_ID}/subscribed_apps$`), 400, { error: { message: 'unsupported' } }], [new RegExp(`/${PAGE_ID}/subscribed_apps$`), 200, { success: true }]])
  await meta.subscribeWebhooks('instagram', { igUserId: IG_ID, pageId: PAGE_ID, accessToken: EAA_PAGE, host: 'facebook' })
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, new RegExp(`/${PAGE_ID}/subscribed_apps$`))

  mock([[/\/subscribed_apps$/, 200, { success: true }]])
  await meta.subscribeWebhooks('instagram', { igUserId: '17841400000000001', accessToken: IGAA })
  assert.deepEqual(hosts(), ['graph.instagram.com'])
})

test('token refresh: IGAA still refreshed with ig_refresh_token; EAA never sent to Instagram\'s refresh', async () => {
  mock([[/graph\.instagram\.com\/refresh_access_token/, 200, { access_token: 'IGAAfresh0123456789' }]])
  await tokens.refreshAll()
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /grant_type=ig_refresh_token/)
  assert.doesNotMatch(calls[0].url, /EAA/)
  assert.equal(meta.numberConfig<{ accessToken: string }>(igNumber).accessToken, 'IGAAfresh0123456789')
  assert.equal(meta.numberConfig<{ accessToken: string }>(fbNumber).accessToken, EAA_PAGE)
})

test('webhook in: object=instagram with entry.id = igUserId lands on the Facebook-route account', async () => {
  mock([[/\?fields=name,username/, 200, { name: 'Amy', username: 'amy' }]])
  meta.handleWebhook({
    object: 'instagram',
    entry: [{ id: IG_ID, time: Date.now(), messaging: [{
      sender: { id: '777001' }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: 'mid.in-1', text: '想問試堂' },
    }] }],
  })
  const row = db.get<{ number_id: number; body: string }>(
    "SELECT c.number_id, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.wa_id = 'mid.in-1'",
  )
  assert.deepEqual({ ...row }, { number_id: fbNumber, body: '想問試堂' })
  await new Promise((r) => setTimeout(r, 50))
  // The customer's name is looked up on the same host as the account.
  assert.ok(calls.every((c) => new URL(c.url).host === 'graph.facebook.com'))
})

test('the echo of a message Baton sent (different id on the Page route) is not stored twice', async () => {
  mock([[/\/messages$/, 200, { message_id: 'aWdfsend-id-1' }]])
  const conv = conversationWithCustomer(fbNumber, '888001')
  const channels = await import('../src/channels.js')
  await channels.sendReply(conv, '多謝你查詢', { userId: t.staff })
  meta.handleWebhook({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{
    sender: { id: IG_ID }, recipient: { id: '888001' }, timestamp: Date.now(), message: { mid: 'bmV3echo-id-1', text: '多謝你查詢', is_echo: true },
  }] }] })
  meta.handleWebhook({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{
    sender: { id: IG_ID }, recipient: { id: '888001' }, timestamp: Date.now(), message: { mid: 'bmV3phone-id-2', text: '我喺手機覆你', is_echo: true },
  }] }] })
  const rows = db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id', conv)
  assert.deepEqual(rows.map((r) => r.body), ['多謝你查詢', '我喺手機覆你'], 'own echo skipped; a real phone reply is kept')
})

test('AI replies on Instagram carry the 👤 轉介同事跟進 quick reply; tapping it hands the chat to a person', async () => {
  const channels = await import('../src/channels.js')
  mock([[/\/messages$/, 200, { message_id: 'm-qr-1' }]])
  db.run("UPDATE numbers SET reply_mode = 'auto' WHERE id = ?", fbNumber)
  try {
    const conv = conversationWithCustomer(fbNumber, '999001')
    await channels.sendReply(conv, '有咩可以幫到你？', { userId: null, aiAuto: true, humanButton: true })
    assert.deepEqual((calls.at(-1)!.body as { message: unknown }).message, {
      text: '有咩可以幫到你？', quick_replies: [{ content_type: 'text', title: meta.HUMAN_BUTTON.title, payload: meta.HUMAN_BUTTON.id }],
    })
    // The customer taps the chip: Instagram sends its title as a message.
    meta.handleWebhook({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{
      sender: { id: '999001' }, recipient: { id: IG_ID }, timestamp: Date.now(),
      message: { mid: 'mid-tap-1', text: meta.HUMAN_BUTTON.title, quick_reply: { payload: meta.HUMAN_BUTTON.id } },
    }] }] })
    const end = Date.now() + 2000
    while (!db.get<{ needs_human: number }>('SELECT needs_human FROM conversations WHERE id = ?', conv)!.needs_human && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    assert.deepEqual({ ...db.get('SELECT needs_human, ai_paused FROM conversations WHERE id = ?', conv) }, { needs_human: 1, ai_paused: 1 })
  } finally {
    db.run("UPDATE numbers SET reply_mode = 'off' WHERE id = ?", fbNumber)
  }
})
