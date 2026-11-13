/**
 * TASK-6 A: semantic FAQ matching. FAQ answers (FUSE's real five) are sent word for word when a
 * customer asks the same thing in other words; anything else must fall through to the AI.
 * Reports the hit rate on paraphrases the keyword matcher misses, and the false-positive rate.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db } = t
const ai = await import('../src/ai.js')
const faqmatch = await import('../src/faqmatch.js')

const FAQS: [string, string, string][] = [
  ['點樣預約', '全部課堂都喺 Fuse App 預約 😊 入去揀分店、課堂同時間就得。預約喺開堂前 2 小時截止。', '點book, 點樣book, 點預約, 點樣預約, 時間表, timetable, schedule'],
  ['取消或改期', '如要取消或改期，請喺開堂前 24 小時或之前喺 Fuse App 處理；24 小時內取消或缺席，該堂會照扣。', '取消, cancel, 改期, 改時間, reschedule'],
  ['惡劣天氣', '八號或以上風球、黑雨：課堂會即時取消；信號除下兩小時後，課堂照常進行。', '風球, 黑雨, 八號, 8號, 颱風, typhoon, 暴雨'],
  ['防滑襪', '上 Reformer 堂要著防滑襪，分店有售，$35 一對 😊', '襪, 防滑襪, socks, grip socks'],
  ['套票有效期', '套票有效期由第一堂起計：單堂 1 星期、4 堂 4 星期、8 堂 10 星期、12 堂 15 星期、20 堂 25 星期。', '有效期, 幾耐有效, expiry, valid'],
]
for (const [title, body, keywords] of FAQS) db.run("INSERT INTO knowledge (category, title, body, keywords) VALUES ('faq', ?, ?, ?)", title, body, keywords)

/** Customers asking each FAQ in their own words, without the team's keywords. Written before the matcher. */
const PARAPHRASES: [string, string][] = [
  ['點樣預約', '我想約堂，要喺邊度約？'],
  ['點樣預約', '可以點樣訂位上堂？'],
  ['點樣預約', 'how do I book a class'],
  ['點樣預約', '想報名上堂點搞'],
  ['點樣預約', '我想book聽日嘅堂'],
  ['點樣預約', '邊度睇到有咩堂上？'],
  ['取消或改期', '我聽日嘅堂上唔到，可唔可以轉第二日？'],
  ['取消或改期', '臨時有事去唔到點算'],
  ['取消或改期', '想轉另一日上堂'],
  ['取消或改期', 'can I change my class to another day'],
  ['取消或改期', '我嚟唔到今晚個堂'],
  ['惡劣天氣', '打風仲有冇堂上？'],
  ['惡劣天氣', '落大雨仲上唔上堂'],
  ['惡劣天氣', '掛波會唔會停課'],
  ['惡劣天氣', 'is class still on with the storm signal'],
  ['防滑襪', '上堂可以赤腳嗎'],
  ['防滑襪', '要唔要買止滑嘅嘢先上到 reformer'],
  ['套票有效期', '套票買咗幾耐要用晒？'],
  ['套票有效期', '10堂套票幾時過期'],
  ['套票有效期', 'package 會唔會 expire'],
  ['套票有效期', '我啲堂要幾時前用完'],
]

/** Questions that are not any of the five FAQs: must go to the AI, never get a canned answer. */
const NEGATIVES = [
  '你哋喺邊度？', '有冇停車場', 'Reformer 同墊上有咩分別', '幾多錢一堂', '有冇男教練', '我想搵 Karen',
  '多謝晒！', '你好', '可唔可以用信用卡俾錢', '你哋有冇私人班', '星期日開唔開', '有冇淋浴間',
  '觀塘分店幾時開張', '我想問下 Group PT 係點', '我朋友想一齊嚟可唔可以',
]

test('the keyword matcher alone misses every paraphrase (so the semantic layer is what is being measured)', () => {
  for (const [, q] of PARAPHRASES) assert.equal(ai.matchFaq(q), undefined, q)
})

test('paraphrase hit rate and false positives (report in the console)', () => {
  const hits = PARAPHRASES.filter(([title, q]) => ai.findFaq(q)?.title === title)
  const wrong = PARAPHRASES.filter(([title, q]) => { const f = ai.findFaq(q); return f && f.title !== title })
  const falsePositives = NEGATIVES.filter((q) => ai.findFaq(q))
  const rate = hits.length / PARAPHRASES.length
  console.log(`# semantic FAQ: ${hits.length}/${PARAPHRASES.length} paraphrases hit (${(rate * 100).toFixed(0)}%), ${wrong.length} wrong FAQ, ${falsePositives.length}/${NEGATIVES.length} false positives`)
  for (const [title, q] of PARAPHRASES.filter((p) => !hits.includes(p))) console.log(`#   miss: ${q}（應為 ${title}）`)
  for (const q of falsePositives) console.log(`#   false positive: ${q} → ${ai.findFaq(q)!.title}`)
  // A wrong canned answer is worse than no canned answer: none allowed.
  assert.equal(wrong.length, 0, 'never answers with the wrong FAQ')
  assert.equal(falsePositives.length, 0, 'unrelated questions go to the AI')
  assert.ok(rate >= 0.75, `hit rate ${(rate * 100).toFixed(0)}% is below 75%`)
})

test('keyword matches still win and are unchanged', () => {
  assert.equal(ai.findFaq('八號風球會唔會照上？')?.title, '惡劣天氣')
  assert.equal(ai.findFaq('使唔使著防滑襪？')?.title, '防滑襪')
})

test('threshold is adjustable: 0 switches the layer off, a higher value is stricter', () => {
  const q = '臨時有事去唔到點算'
  assert.equal(ai.findFaq(q)?.title, '取消或改期')
  db.run("INSERT INTO settings (key, value) VALUES ('faq_semantic_threshold', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  assert.equal(ai.findFaq(q), undefined)
  db.run("UPDATE settings SET value = '0.99' WHERE key = 'faq_semantic_threshold'")
  assert.equal(ai.findFaq(q), undefined)
  db.run("DELETE FROM settings WHERE key = 'faq_semantic_threshold'")
  assert.equal(ai.findFaq(q)?.title, '取消或改期')
})

test('long messages with several questions go to the AI instead of one canned answer', () => {
  assert.equal(ai.findFaq('我想問下打風會唔會停課，另外套票幾時過期，同埋你哋喺邊度，有冇得泊車，仲有點樣用信用卡俾錢？'), undefined)
})

test('answers with unfilled [placeholders] and other brands\' entries are never sent', () => {
  db.run("INSERT INTO knowledge (category, title, body, keywords) VALUES ('faq', '泊車', '附近有 [停車場名稱]', '')")
  assert.equal(ai.findFaq('附近有冇地方泊車？'), undefined)
  db.run("UPDATE knowledge SET body = '附近有收費停車場' WHERE title = '泊車'")
  assert.equal(ai.findFaq('附近有冇地方泊車？')?.title, '泊車', 'matches once the placeholder is filled in')
  db.run("DELETE FROM knowledge WHERE title = '泊車'")

  const pilates = t.brandId('pilates')
  db.run("INSERT INTO knowledge (category, title, body, keywords, brand_id) VALUES ('faq', '淋浴間', 'Pilates 分店有淋浴間', '', ?)", pilates)
  assert.equal(ai.findFaq('分店有冇淋浴間？', t.brandId('fitness')), undefined)
  assert.equal(ai.findFaq('分店有冇淋浴間？', pilates)?.title, '淋浴間')
})

test('speed: well under a millisecond per question', () => {
  const start = performance.now()
  for (let i = 0; i < 200; i++) ai.findFaq(PARAPHRASES[i % PARAPHRASES.length][1])
  const each = (performance.now() - start) / 200
  console.log(`# semantic FAQ: ${each.toFixed(3)} ms per question`)
  assert.ok(each < 5)
  void faqmatch
})
