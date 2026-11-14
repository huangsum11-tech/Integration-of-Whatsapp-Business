/**
 * TASK-10: a wa_web number flagged `contactsOnly` in its config borrows the QR-linked
 * phone's contact sync for an official Cloud API number. It must keep saved names fresh
 * while never sending, and the send guard must fire before the socket check so callers
 * get the sync-only error rather than "not connected".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, inbox } = t
const wa = await import('../src/whatsapp.js')

const addNumber = (label: string, config?: string) => Number(db.run(
  "INSERT INTO numbers (label, status, channel, config) VALUES (?, 'starting', 'wa_web', ?)",
  label, config ?? '{}',
).lastInsertRowid)
const syncLink = addNumber('Fuse Fitness 名稱同步', JSON.stringify({ contactsOnly: true }))
const plainLink = addNumber('普通 QR 號碼')
const falseFlag = addNumber('標記為 false', JSON.stringify({ contactsOnly: false }))
const emptyConfig = addNumber('空設定', '')
const badJson = addNumber('壞 JSON', '{oops')

test('isContactsOnly: only config contactsOnly === true counts', () => {
  assert.equal(wa.isContactsOnly(syncLink), true)
  assert.equal(wa.isContactsOnly(plainLink), false, 'no flag in config')
  assert.equal(wa.isContactsOnly(falseFlag), false, 'explicit false')
  assert.equal(wa.isContactsOnly(emptyConfig), false, 'empty config')
  assert.equal(wa.isContactsOnly(badJson), false, 'unparseable config counts as false')
  assert.equal(wa.isContactsOnly(999_999), false, 'unknown number')
})

test('sendText on a contacts-only link throws the sync-only error before the socket check', async () => {
  // No socket exists for this number; the contacts-only guard must win over 此號碼未連接.
  await assert.rejects(
    wa.sendText(syncLink, '85290000000@s.whatsapp.net', 'hi', null, false),
    /此連結只作聯絡人名同步，不能發送訊息/,
  )
  await assert.rejects(
    wa.sendText(plainLink, '85290000000@s.whatsapp.net', 'hi', null, false),
    /此號碼未連接/,
    'a plain QR number without a socket still reports not connected',
  )
})

test('sendImageFile on a contacts-only link throws the sync-only error before touching socket or file', async () => {
  await assert.rejects(
    wa.sendImageFile(syncLink, '85290000000@s.whatsapp.net', '/nonexistent/qr.png', '', null),
    /此連結只作聯絡人名同步，不能發送訊息/,
  )
})

test('resolveContact with a saved name updates saved_name but never the manual name', () => {
  const pn = '85297776666'
  const id = inbox.resolveContact({ pn }, { wa: '客人檔案名' })
  db.run("UPDATE contacts SET name = '同事改名' WHERE id = ?", id)
  const again = inbox.resolveContact({ pn }, { saved: '電話簿儲存名' })
  assert.equal(again, id)
  const c = db.get<{ name: string | null; saved_name: string | null; wa_name: string | null }>(
    'SELECT name, saved_name, wa_name FROM contacts WHERE id = ?', id,
  )!
  assert.equal(c.saved_name, '電話簿儲存名')
  assert.equal(c.name, '同事改名', 'manual rename is never overwritten by a sync')
  assert.equal(c.wa_name, '客人檔案名')
})
