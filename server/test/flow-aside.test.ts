/**
 * TASK-6 B: a question asked in the middle of a trial or purchase flow is answered, then the
 * flow's question is asked again. The question is never taken as the step's answer.
 * Simulated WhatsApp conversations on the demo numbers; the AI is a scripted model.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, say } = t
const llm = await import('../src/llm.js')

db.run("UPDATE brands SET booking_url = 'https://example.test/book'")
for (const [title, body, keywords] of [
  ['泊車', '附近有收費停車場，步行 3 分鐘 🚗', '泊車, 停車'],
  ['付款方式', '可以喺 Fuse App 用信用卡，亦可以用 FPS／PayMe。', '信用卡, credit card'],
  ['惡劣天氣', '八號或以上風球、黑雨：課堂會即時取消；信號除下兩小時後，課堂照常進行。', '風球, 黑雨, 八號, 颱風'],
  ['套票有效期', '套票有效期由第一堂起計。', '有效期, 幾耐有效'],
]) db.run("INSERT INTO knowledge (category, title, body, keywords) VALUES ('faq', ?, ?, ?)", title, body, keywords)

const prompts: string[] = []
llm.useScriptedModel((req) => {
  prompts.push(String(req.messages.at(-1)?.content ?? ''))
  return 'Reformer 用彈簧器械，阻力可以調；墊上就靠自己體重，兩樣都適合初學 😊'
})

let seq = 0
const phone = () => `8526200${String(seq++).padStart(4, '0')}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The customer says something; wait until the team side has sent `count` messages after it. */
async function exchange(numberId: number, from: string, body: string, count: number) {
  const s = say(numberId, from, body)
  const end = Date.now() + 3000
  let out: string[] = []
  while (Date.now() < end) {
    out = db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 AND id > ? ORDER BY id', s.conversationId, s.messageId).map((m) => m.body)
    if (out.length >= count) break
    await sleep(20)
  }
  await sleep(80)
  return { conversationId: s.conversationId, out: db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 AND id > ? ORDER BY id', s.conversationId, s.messageId).map((m) => m.body) }
}

const flowOf = (conversationId: number) => db.get<{ step: string; status: string; data: string }>('SELECT step, status, data FROM flows WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', conversationId)!

test('trial: a question at the name/time step is answered, the step is asked again, and the question is not saved as the name', async () => {
  const p = phone()
  await exchange(t.fitness, p, '我想試堂', 1)
  await exchange(t.fitness, p, '1', 1) // 筲箕灣
  const atInfo = await exchange(t.fitness, p, '3', 1) // Reformer 1 堂
  assert.equal(flowOf(atInfo.conversationId).step, 'info')

  const aside = await exchange(t.fitness, p, '附近有冇得泊車？', 2)
  assert.equal(aside.out[0], '附近有收費停車場，步行 3 分鐘 🚗')
  assert.equal(aside.out[1], '講返試堂：請問點稱呼你？想上邊日、大約幾點？')
  assert.equal(flowOf(aside.conversationId).step, 'info', 'the flow did not move on')
  assert.equal(db.get<{ name: string | null }>('SELECT ct.name FROM contacts ct JOIN conversations c ON c.contact_id = ct.id WHERE c.id = ?', aside.conversationId)!.name, null)

  const named = await exchange(t.fitness, p, '我叫Amy，想星期六早上', 1)
  assert.match(named.out[0], /https:\/\/example\.test\/book/)
  assert.equal(flowOf(named.conversationId).step, 'booking')
  assert.equal(db.get<{ name: string }>('SELECT ct.name FROM contacts ct JOIN conversations c ON c.contact_id = ct.id WHERE c.id = ?', named.conversationId)!.name, 'Amy')

  // At the "when did you book?" step a question doesn't count as a failed try.
  const weather = await exchange(t.fitness, p, '打風會唔會停課？', 2)
  assert.match(weather.out[0], /風球/)
  assert.equal(weather.out[1], '講返試堂：預約好之後，話我知你預約咗邊日、幾點就得 😊')
  assert.equal(JSON.parse(flowOf(weather.conversationId).data).tries, undefined)

  const booked = await exchange(t.fitness, p, '聽日 晚上7點', 1)
  assert.match(booked.out[0], /收到！已記錄/)
  assert.equal(flowOf(booked.conversationId).status, 'done')
})

test('trial: the AI answers a question with no FAQ, knowing a flow is waiting, then the flow resumes', async () => {
  const p = phone()
  await exchange(t.fitness, p, '我想試堂', 1)
  const offers = await exchange(t.fitness, p, '筲箕灣', 1)
  const before = prompts.length
  const aside = await exchange(t.fitness, p, 'Reformer 同墊上有咩分別？', 2)
  assert.equal(prompts.length, before + 1, 'the AI was asked')
  assert.match(prompts.at(-1)!, /<flow_in_progress>/)
  assert.match(aside.out[0], /彈簧器械/)
  assert.match(aside.out[1], /^講返試堂：想試邊一個？/)
  assert.equal(flowOf(offers.conversationId).step, 'offer')
  const chosen = await exchange(t.fitness, p, '1', 1)
  assert.equal(flowOf(chosen.conversationId).step, 'info')
})

test('answers are still taken as answers: a time phrased as a question, and plain non-answers re-prompt as before', async () => {
  const p = phone()
  await exchange(t.fitness, p, '我想試堂', 1)
  await exchange(t.fitness, p, '1', 1)
  const unclear = await exchange(t.fitness, p, 'hmm', 1)
  assert.match(unclear.out[0], /^想試邊一個呢？/)
  await exchange(t.fitness, p, '1', 1)
  const asked = await exchange(t.fitness, p, '星期六早上得唔得？', 1)
  assert.match(asked.out[0], /https:\/\/example\.test\/book/)
  assert.equal(flowOf(asked.conversationId).step, 'booking')
})

test('purchase: questions at the category and confirm steps are answered, then the step resumes', async () => {
  const p = phone()
  await exchange(t.pilates, p, '我想買套票', 1)
  const pay = await exchange(t.pilates, p, '可唔可以用信用卡俾錢？', 2)
  assert.equal(pay.out[0], '可以喺 Fuse App 用信用卡，亦可以用 FPS／PayMe。')
  assert.match(pay.out[1], /^講返套票：想買邊類？/)
  assert.equal(flowOf(pay.conversationId).step, 'category')

  await exchange(t.pilates, p, '1', 1)
  const confirm = await exchange(t.pilates, p, '4堂', 1)
  assert.match(confirm.out[0], /確認購買？/)
  const expiry = await exchange(t.pilates, p, '套票幾時過期？', 2)
  assert.equal(expiry.out[0], '套票有效期由第一堂起計。')
  assert.equal(expiry.out[1], '講返套票：確認購買嘅話，回覆「確認」就得；唔要可以回覆「取消」。')
  assert.equal(flowOf(expiry.conversationId).step, 'confirm')
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payment_requests WHERE conversation_id = ?', expiry.conversationId)!.c, 0, 'no payment request from the question')
})

test('sensitive topics still stop the flow at once, even phrased as a question', async () => {
  const p = phone()
  await exchange(t.fitness, p, '我想試堂', 1)
  await exchange(t.fitness, p, '1', 1)
  const s = say(t.fitness, p, '我膝頭痛，可唔可以上？')
  await sleep(300)
  assert.equal(flowOf(s.conversationId).status, 'aborted')
  assert.equal(db.get<{ needs_human: number }>('SELECT needs_human FROM conversations WHERE id = ?', s.conversationId)!.needs_human, 1)
})
