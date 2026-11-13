/**
 * TASK-6 C: system prompt v2 behaviour, with the red lines enforced in code.
 * - Clarify before handing off: the AI may ask one question; a second in a row becomes a handoff.
 * - Cases that must go to a person (refunds, complaints, disputed deductions, health, balance,
 *   asking for a person) are never delayed by a clarifying question.
 * - Grounding is unchanged: prices only from the brand catalogue and knowledge base.
 * - Less "AI" tone: plain text, no markdown.
 * The AI is a scripted model; what it is told is checked from the request it receives.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, say } = t
const ai = await import('../src/ai.js')
const llm = await import('../src/llm.js')
const autoreply = await import('../src/autoreply.js')

const requests: { instructions: string; context: string }[] = []
let script: string[] = []
llm.useScriptedModel((req) => {
  requests.push({ instructions: req.instructions, context: req.context ?? '' })
  return script.shift() ?? 'HANDOFF: 未有預設回覆'
})

let seq = 0
const phone = () => `8526300${String(seq++).padStart(4, '0')}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const outgoing = (id: number) => db.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY id', id).map((m) => m.body)
const needsHuman = (id: number) => db.get<{ needs_human: number }>('SELECT needs_human FROM conversations WHERE id = ?', id)!.needs_human
const clarifications = (id: number) => db.get<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE conversation_id = ? AND kind = 'ai_clarify'", id)!.c

async function settle(id: number, check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await sleep(20)
  await sleep(60)
  return id
}

test('parseReply: CLARIFY is a reply marked as the clarifying question; markdown is removed', () => {
  assert.deepEqual(ai.parseReply('CLARIFY: 想問你係新學員定舊學員？'), { action: 'reply', text: '想問你係新學員定舊學員？', clarify: true })
  assert.equal((ai.parseReply('**Reformer** 堂用器械\n## 注意\n要著防滑襪') as { text: string }).text, 'Reformer 堂用器械\n注意\n要著防滑襪')
  assert.deepEqual(ai.parseReply('HANDOFF: 客人要退款'), { action: 'handoff', reason: '客人要退款' })
})

test('one clarifying question, then a handoff if it is still unclear', async () => {
  const p = phone()
  script = ['CLARIFY: 想問你係新學員定舊學員？']
  const first = say(t.fitness, p, '想問下 Reformer 堂點收費')
  await settle(first.conversationId, () => outgoing(first.conversationId).length === 1)
  assert.deepEqual(outgoing(first.conversationId), ['想問你係新學員定舊學員？'])
  assert.equal(clarifications(first.conversationId), 1)
  assert.equal(needsHuman(first.conversationId), 0, 'asking first, not handing off')

  script = ['CLARIFY: 你想上邊間分店？']
  const second = say(t.fitness, p, '唔太肯定')
  await settle(second.conversationId, () => needsHuman(second.conversationId) === 1)
  assert.equal(needsHuman(second.conversationId), 1, 'a second clarification in a row becomes a handoff')
  assert.equal(clarifications(second.conversationId), 1)
  assert.equal(outgoing(second.conversationId).length, 1, 'no second question sent')
})

test('a clarification answered, then a normal reply: the next unclear question may clarify again', async () => {
  const p = phone()
  script = ['CLARIFY: 你想上邊間分店？']
  const a = say(t.fitness, p, '有冇早上堂')
  await settle(a.conversationId, () => outgoing(a.conversationId).length === 1)
  script = ['筲箕灣朝早有 Interval 同 TRX 😊']
  const b = say(t.fitness, p, '筲箕灣')
  await settle(b.conversationId, () => outgoing(b.conversationId).length === 2)
  script = ['CLARIFY: 想問係邊類堂？']
  const c = say(t.fitness, p, '咁夜晚呢')
  await settle(c.conversationId, () => outgoing(c.conversationId).length === 3)
  assert.equal(outgoing(c.conversationId).at(-1), '想問係邊類堂？')
  assert.equal(needsHuman(c.conversationId), 0)
})

test('red line: asking for a person is handed off even if the model tries to clarify', async () => {
  script = ['CLARIFY: 想問你有咩需要？']
  const s = say(t.fitness, phone(), '我想搵真人問下')
  await settle(s.conversationId, () => needsHuman(s.conversationId) === 1)
  assert.equal(needsHuman(s.conversationId), 1)
  assert.equal(clarifications(s.conversationId), 0)
})

test('red line: refund, complaint, disputed deduction, health and balance go to a person before the AI is asked', async () => {
  for (const text of ['我想退款', '你哋啲服務好差，我要投訴', '點解扣咗我堂？', '我膝頭痛可唔可以上', '我仲有幾多堂？']) {
    const before = requests.length
    script = ['CLARIFY: 可唔可以講多少少？']
    const s = say(t.fitness, phone(), text)
    await settle(s.conversationId, () => needsHuman(s.conversationId) === 1)
    assert.equal(needsHuman(s.conversationId), 1, text)
    assert.equal(requests.length, before, `${text}: the AI was not even asked`)
    assert.equal(clarifications(s.conversationId), 0, text)
  }
  // And the code guard alone, for the same cases worded so that only the guard sees them.
  const reply = { action: 'reply' as const, text: '想問多啲？', clarify: true }
  assert.equal(autoreply.guardClarify(0, '我想退款', reply).action, 'handoff')
  assert.equal(autoreply.guardClarify(0, 'can I talk to a human', reply).action, 'handoff')
})

test('grounding unchanged and v2 rules present in what the model is told', async () => {
  script = ['好']
  const s = say(t.fitness, phone(), '你好')
  await settle(s.conversationId, () => outgoing(s.conversationId).length === 1)
  const { instructions, context } = requests.at(-1)!
  // Grounding red line, word for word as before TASK-6.
  assert.match(instructions, /Quote only the prices in this conversation's <brand> block or knowledge base, exactly as written\./)
  assert.match(instructions, /Never compute a discounted price/)
  assert.match(instructions, /Never invent or estimate prices, dates, availability or policies\./)
  assert.match(context, /<brand name="Fuse Fitness"/)
  // v2 behaviour.
  assert.match(instructions, /Never clarify the hand-off-at-once cases above\./)
  assert.match(instructions, /Ask at most once in a row\./)
  // v2 rules added on the Mac after checking the full spec (2026-11-13).
  assert.match(instructions, /give the number of classes and the validity period/)
  assert.match(instructions, /Never promise a discount, free class or special arrangement/)
  assert.match(instructions, /answer honestly in one light sentence/)
  assert.match(instructions, /corporate partnership, a job, or a media enquiry/)
  assert.match(instructions, /never ask for ID card numbers, bank details or passwords/)
  assert.match(instructions, /don't ask them to repeat it/)
  // Aligned with system_prompt_v2 (Sum, 2026-11-13): knowledge base only, no guessing, no stock phrases.
  assert.match(instructions, /Answer only from the knowledge base and the <brand> block below, for everything/)
  assert.match(instructions, /never guess opening hours, today's free spots/)
  assert.match(instructions, /Never tell the customer a booking is confirmed/)
  assert.match(instructions, /No customer-service stock phrases/)
  assert.doesNotMatch(instructions, /from general knowledge/)
  assert.match(instructions, /Combine everything that is written into one answer/)
  assert.match(instructions, /never fill the gap with a guess/)
  assert.match(instructions, /spoken Cantonese/)
  assert.match(instructions, /Plain text only/)
})
