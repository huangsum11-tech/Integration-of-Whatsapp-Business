/**
 * D. Customer identity alignment: no raw LID digits in the inbox, LIDs merged into the real
 * number once known, Cloud API by wa_id + profile name, Instagram username + name, and the
 * display order 同事儲存名 > WhatsApp／IG 名 > 電話.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, inbox } = t
const identity = await import('../src/identity.js')
const meta = await import('../src/meta.js')
const wa = Number(db.run("INSERT INTO numbers (label, phone, status, channel) VALUES ('QR', '85260000000', 'connected', 'wa_web')").lastInsertRowid)
const LID = '187654321098765'

const contactOf = (conversationId: number) => inbox.getConversation(conversationId)

function store(jid: string, ids: { pn?: string; lid?: string }, waName?: string, numberId = wa) {
  return inbox.storeMessage({
    numberId, jid, contact: ids, waName, waId: `id-${Math.random()}`, fromMe: false, type: 'text', body: 'hi',
    ts: Math.floor(Date.now() / 1000), live: false,
  })!
}

test('JID kinds: @lid and @hosted.lid are LIDs, never phone numbers', () => {
  assert.deepEqual(identity.customerIds(`${LID}@lid`), { pn: undefined, lid: LID })
  assert.deepEqual(identity.customerIds(`${LID}@hosted.lid`), { pn: undefined, lid: LID })
  assert.deepEqual(identity.customerIds('85291234567@s.whatsapp.net', `${LID}@lid`), { pn: '85291234567', lid: LID })
  assert.deepEqual(identity.customerIds(`${LID}:3@lid`, '85291234567@hosted'), { pn: '85291234567', lid: LID })
  assert.deepEqual(identity.customerIds('120363@g.us'), { pn: undefined, lid: undefined })
})

test('LID-only customer: no digits shown, marked 號碼未解析', () => {
  const s = store(`${LID}@hosted.lid`, identity.customerIds(`${LID}@hosted.lid`))
  const c = contactOf(s.conversationId)
  assert.equal(c.phone, null)
  assert.equal(c.contact_name, '號碼未解析')
  assert.ok(!String(c.contact_name).includes(LID))
})

test('LID-only customer with a WhatsApp name shows the name, still without digits', () => {
  const lid2 = '199999999999999'
  const s = store(`${lid2}@lid`, { lid: lid2 }, 'Amy Chan')
  const c = contactOf(s.conversationId)
  assert.equal(c.contact_name, 'Amy Chan')
  assert.equal(c.phone, null)
})

test('the LID maps to a real number later: one customer, one conversation, real phone', () => {
  const lid3 = '177777777777777'
  const viaLid = store(`${lid3}@lid`, { lid: lid3 }, 'Ben')
  const viaPhone = store('85298887777@s.whatsapp.net', { pn: '85298887777' })
  assert.notEqual(contactOf(viaLid.conversationId).contact_id, contactOf(viaPhone.conversationId).contact_id)
  assert.equal(inbox.rememberLid(lid3, '85298887777'), true)
  const merged = db.all<{ id: number }>("SELECT id FROM contacts WHERE phone = '85298887777' OR lid = ?", lid3)
  assert.equal(merged.length, 1, 'contacts merged')
  const conversations = db.all('SELECT id FROM conversations WHERE contact_id = ?', merged[0].id)
  assert.equal(conversations.length, 1, 'conversations merged')
  const c = contactOf((conversations[0] as { id: number }).id)
  assert.equal(c.phone, '85298887777')
  assert.equal(c.contact_name, 'Ben')
})

test('old data: hosted LID stored as a phone number is repaired at start-up', () => {
  const lid4 = '166666666666666'
  // How the previous version stored it: phone = LID digits, no lid.
  const contactId = Number(db.run('INSERT INTO contacts (phone) VALUES (?)', lid4).lastInsertRowid)
  const conv = Number(db.run("INSERT INTO conversations (number_id, contact_id, jid) VALUES (?, ?, ?)", wa, contactId, `${lid4}@hosted.lid`).lastInsertRowid)
  assert.equal(contactOf(conv).phone, lid4, 'before the repair the digits showed as a phone')
  assert.ok(identity.repairLidContacts() >= 1)
  assert.equal(contactOf(conv).phone, null)
  assert.equal(contactOf(conv).contact_name, '號碼未解析')
})

test('display order: 同事儲存名 > 手機通訊錄名 > WhatsApp 名 > 電話', () => {
  const s = store('85291112233@s.whatsapp.net', { pn: '85291112233' }, 'WA Name')
  const id = contactOf(s.conversationId).contact_id
  assert.equal(contactOf(s.conversationId).contact_name, 'WA Name')
  db.run("UPDATE contacts SET saved_name = 'Phonebook Name' WHERE id = ?", id)
  assert.equal(contactOf(s.conversationId).contact_name, 'Phonebook Name')
  db.run("UPDATE contacts SET name = 'Staff Name' WHERE id = ?", id)
  assert.equal(contactOf(s.conversationId).contact_name, 'Staff Name')
  db.run('UPDATE contacts SET name = NULL, saved_name = NULL, wa_name = NULL WHERE id = ?', id)
  assert.equal(contactOf(s.conversationId).contact_name, '85291112233')
})

test('Cloud API: customer aligned by wa_id and profile name from the webhook', () => {
  const cloud = Number(db.run(`INSERT INTO numbers (label, phone, status, channel, config) VALUES ('Cloud', '85255550000', 'connected', 'wa_cloud', '{"phoneNumberId":"PN1","accessToken":"x"}')`).lastInsertRowid)
  meta.handleWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PN1' },
      contacts: [{ wa_id: '85293334444', profile: { name: '陳大文' } }],
      messages: [{ id: 'wamid.X', from: '85293334444', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '你好' } }],
    } }] }],
  })
  const c = db.get<{ phone: string; wa_name: string }>("SELECT ct.phone, ct.wa_name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.number_id = ?", cloud)!
  assert.equal(c.phone, '85293334444')
  assert.equal(c.wa_name, '陳大文')
})

test('Instagram: username and name looked up from the Graph API', async () => {
  const ig = Number(db.run(`INSERT INTO numbers (label, phone, status, channel, config) VALUES ('IG', '@fusepilateshk', 'connected', 'instagram', '{"igUserId":"IG1","accessToken":"x"}')`).lastInsertRowid)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/IGSID9')) return new Response(JSON.stringify({ name: 'Mandy Wong', username: 'mandy.w' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  try {
    meta.handleWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'IGSID9' }, recipient: { id: 'IG1' }, timestamp: Date.now(), message: { mid: 'm1', text: '想問價錢' } }] }] })
    await new Promise((r) => setTimeout(r, 100))
    const c = db.get<{ name: string }>(`SELECT ${'COALESCE(ct.name, ct.saved_name, ct.wa_name)'} AS name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.number_id = ?`, ig)!
    assert.equal(c.name, 'Mandy Wong (@mandy.w)')
  } finally {
    globalThis.fetch = realFetch
  }
})
