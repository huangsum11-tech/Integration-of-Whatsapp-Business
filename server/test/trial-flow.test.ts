/**
 * A. New-customer trial flow — acceptance tests from the spec:
 * one full run per branch (筲箕灣, 新蒲崗, 觀塘), prices match the knowledge base, no brand mix-up,
 * reminders scheduled correctly, sensitive topics stop the flow.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hkDayText, setup } from './helpers.ts'

const t = await setup()
const { db, fitness, pilates, brandId } = t
db.run("UPDATE brands SET booking_url = 'https://book.example/fitness', booking_platform = 'Fuse App' WHERE key = 'fitness'")
db.run("UPDATE brands SET booking_url = 'https://book.example/pilates', booking_platform = 'Fuse App' WHERE key = 'pilates'")

async function fullRun(numberId: number, phone: string, branchAnswer: string, branchName: string, expectPrices: string[], forbidden: string[], link: string) {
  const start = await t.ask(numberId, phone, '你好，我想試堂')
  assert.match(start.text, /筲箕灣/)
  assert.match(start.text, /新蒲崗/)
  assert.match(start.text, /觀塘/)

  const offers = await t.ask(numberId, phone, branchAnswer)
  assert.match(offers.text, new RegExp(branchName))
  assert.match(offers.text, /每位只限用一次/)
  for (const p of expectPrices) assert.ok(offers.text.includes(p), `missing price ${p}:\n${offers.text}`)
  for (const p of forbidden) assert.ok(!offers.text.includes(p), `must not show ${p}:\n${offers.text}`)

  const chose = await t.ask(numberId, phone, '1')
  assert.match(chose.text, /點稱呼你/)

  const linkMsg = await t.ask(numberId, phone, '我叫陳小美，想星期六晚上')
  assert.ok(linkMsg.text.includes(link), linkMsg.text)
  assert.match(linkMsg.text, /預約步驟/)
  assert.match(linkMsg.text, /陳小美/)
  for (const other of ['https://book.example/fitness', 'https://book.example/pilates'].filter((l) => l !== link)) {
    assert.ok(!linkMsg.text.includes(other), 'other brand link leaked')
  }

  const booked = await t.ask(numberId, phone, `訂咗 ${hkDayText(3)}`)
  assert.match(booked.text, /已記錄你/)
  assert.match(booked.text, new RegExp(branchName))
  const trial = db.get<{ class_at: number; branch_key: string; brand_id: number; reminder_day_status: string }>(
    'SELECT t.* FROM trials t JOIN contacts ct ON ct.id = t.contact_id WHERE ct.phone = ?', phone,
  )!
  assert.ok(trial, 'trial recorded')
  const tags = db.all<{ tag: string }>('SELECT tag FROM contact_tags g JOIN contacts ct ON ct.id = g.contact_id WHERE ct.phone = ?', phone).map((r) => r.tag)
  assert.ok(tags.includes('已預約試堂'), `tags: ${tags}`)
  assert.ok(!tags.includes('新生-試堂中'))
  return { conversationId: booked.conversationId, trial }
}

test('筲箕灣 on the Fuse Fitness number: Fitness prices and link only', async () => {
  const { trial } = await fullRun(fitness, '85291110001', '1', '筲箕灣', ['恆常小組 1 堂 $120', '恆常小組 3 堂 $330', 'Reformer 1 堂 $220', '私人訓練 一對一 首堂 $400'], [], 'https://book.example/fitness')
  assert.equal(trial.brand_id, brandId('fitness'))
  assert.equal(trial.branch_key, 'skw')
})

test('新蒲崗 on the Fuse Pilates number: Pilates offers only (no group class)', async () => {
  const { trial } = await fullRun(pilates, '85291110002', '新蒲崗', '新蒲崗', ['Reformer 1 堂 $220', 'Reformer 3 堂 $600'], ['恆常小組'], 'https://book.example/pilates')
  assert.equal(trial.brand_id, brandId('pilates'))
  assert.equal(trial.branch_key, 'spk')
})

test('觀塘 on the Fuse Pilates number', async () => {
  const { trial } = await fullRun(pilates, '85291110003', 'KT', '觀塘', ['Reformer 1 堂 $220', '私人訓練 一對二 首堂 $600'], ['恆常小組'], 'https://book.example/pilates')
  assert.equal(trial.branch_key, 'kt')
})

test('Fitness number asked about 觀塘: no prices, refers to the Pilates WhatsApp, team flagged', async () => {
  await t.ask(fitness, '85291110004', '想試堂')
  const r = await t.ask(fitness, '85291110004', '觀塘')
  assert.match(r.text, /5405 4224/)
  assert.ok(!/\$\d/.test(r.text), `no prices: ${r.text}`)
  assert.equal(db.get<{ n: number }>('SELECT needs_human AS n FROM conversations WHERE id = ?', r.conversationId)!.n, 1)
})

test('reminders: the day before and 2 hours before, once each', async () => {
  const trialRow = db.get<{ id: number; conversation_id: number }>("SELECT id, conversation_id FROM trials WHERE branch_key = 'skw'")!
  const before = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND from_me = 1', trialRow.conversation_id)!.c
  db.run('UPDATE trials SET class_at = unixepoch() + 20 * 3600 WHERE id = ?', trialRow.id)
  await t.automation.trialReminders()
  await t.automation.trialReminders()
  let row = db.get<{ reminder_day_status: string; reminder_2h_status: string }>('SELECT * FROM trials WHERE id = ?', trialRow.id)!
  assert.equal(row.reminder_day_status, 'sent')
  assert.equal(row.reminder_2h_status, 'pending')
  const day = db.get<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id DESC LIMIT 1', trialRow.conversation_id)!.body
  assert.match(day, /聽日/)
  assert.match(day, /筲箕灣/)
  db.run('UPDATE trials SET class_at = unixepoch() + 90 * 60 WHERE id = ?', trialRow.id)
  await t.automation.trialReminders()
  await t.automation.trialReminders()
  row = db.get<{ reminder_day_status: string; reminder_2h_status: string }>('SELECT * FROM trials WHERE id = ?', trialRow.id)!
  assert.equal(row.reminder_2h_status, 'sent')
  const after = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND from_me = 1', trialRow.conversation_id)!.c
  assert.equal(after - before, 2, 'exactly two reminders')
})

test('a trial booked less than a day ahead skips the day-before reminder', async () => {
  const trialRow = db.get<{ id: number }>("SELECT id FROM trials WHERE branch_key = 'spk'")!
  db.run('UPDATE trials SET class_at = unixepoch() + 3600 WHERE id = ?', trialRow.id)
  await t.automation.trialReminders()
  const row = db.get<{ reminder_day_status: string; reminder_2h_status: string }>('SELECT * FROM trials WHERE id = ?', trialRow.id)!
  assert.equal(row.reminder_day_status, 'skipped')
  assert.equal(row.reminder_2h_status, 'sent')
})

test('follow-up goes out within 24 hours after the class', async () => {
  const trialRow = db.get<{ id: number; conversation_id: number }>("SELECT id, conversation_id FROM trials WHERE branch_key = 'kt'")!
  db.run('UPDATE trials SET class_at = unixepoch() - 3 * 3600 WHERE id = ?', trialRow.id)
  await t.automation.followUps()
  assert.equal(db.get<{ s: string }>('SELECT followup_status AS s FROM trials WHERE id = ?', trialRow.id)!.s, 'sent')
})

test('refund mentioned mid-flow: the flow stops and goes to a person', async () => {
  await t.ask(pilates, '85291110005', '我想試堂')
  await t.ask(pilates, '85291110005', '新蒲崗')
  const r = await t.ask(pilates, '85291110005', '其實我想退款')
  const flow = db.get<{ status: string }>('SELECT f.status FROM flows f WHERE f.conversation_id = ? ORDER BY id DESC', r.conversationId)!
  assert.equal(flow.status, 'aborted')
  assert.equal(db.get<{ n: number }>('SELECT needs_human AS n FROM conversations WHERE id = ?', r.conversationId)!.n, 1)
  assert.ok(!/\$\d/.test(r.text))
})

test('customer cannot book alone: data collected, handed to a person', async () => {
  await t.ask(fitness, '85291110006', 'trial class please')
  await t.ask(fitness, '85291110006', '筲箕灣')
  await t.ask(fitness, '85291110006', '3')
  await t.ask(fitness, '85291110006', 'Amy，平日晚上')
  const r = await t.ask(fitness, '85291110006', '唔識用，幫我訂')
  const ev = db.get<{ body: string }>("SELECT body FROM events WHERE conversation_id = ? AND kind = 'ai_handoff' ORDER BY id DESC", r.conversationId)!
  assert.match(ev.body, /代訂/)
  assert.match(ev.body, /平日晚上/)
})

test('no booking link set: no invented link, a person takes over', async () => {
  db.run("UPDATE brands SET booking_url = '' WHERE key = 'fitness'")
  await t.ask(fitness, '85291110007', '想試堂')
  await t.ask(fitness, '85291110007', '1')
  await t.ask(fitness, '85291110007', '1')
  const r = await t.ask(fitness, '85291110007', 'Ben 星期日')
  assert.ok(!/https?:\/\//.test(r.text), r.text)
  const ev = db.get<{ body: string }>("SELECT body FROM events WHERE conversation_id = ? AND kind = 'ai_handoff' ORDER BY id DESC", r.conversationId)!
  assert.match(ev.body, /預約連結未設定/)
  db.run("UPDATE brands SET booking_url = 'https://book.example/fitness' WHERE key = 'fitness'")
})

test('date parsing: Chinese, day/month and relative days', () => {
  const { parseBookedTime } = t.flows
  const base = new Date('2026-11-07T04:00:00Z') // Sat 12:00 HKT
  const fmt = (ts: number | null) => (ts ? new Date(ts * 1000 + 8 * 3600_000).toISOString().slice(0, 16) : null)
  assert.equal(fmt(parseBookedTime('11月12日 晚上7點', base)), '2026-11-12T19:00')
  assert.equal(fmt(parseBookedTime('12/11 19:30', base)), '2026-11-12T19:30')
  assert.equal(fmt(parseBookedTime('聽日 10:00am', base)), '2026-11-08T10:00')
  assert.equal(fmt(parseBookedTime('星期二 下午3點半', base)), '2026-11-10T15:30')
  assert.equal(parseBookedTime('仲未訂', base), null)
})
