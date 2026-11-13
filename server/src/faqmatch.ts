/**
 * Semantic FAQ matching: catches a customer asking an FAQ in their own words, without the
 * team's keywords ("臨時有事去唔到點算" → 取消或改期). It runs after the keyword match and before
 * the AI, on the server itself: no API, no cost, well under a millisecond, the same with every
 * AI provider.
 *
 * How: phrases with the same meaning are first folded into one concept ("約堂／訂位／book" →
 * 預約); the question is then compared with each FAQ's title and keywords (and, more lightly,
 * its answer) by TF-IDF cosine similarity over concepts, Chinese character pairs and English
 * words. An FAQ answer is used only when its score passes the threshold AND clearly beats the
 * runner-up; anything uncertain goes to the AI, because a wrong canned answer is worse than none.
 */
import { all, getSetting } from './db.js'

/** Default similarity needed to send an FAQ answer word for word; "設定 → AI 及知識庫" can change it (0 = off). */
export const DEFAULT_THRESHOLD = 0.4
/** How far the best FAQ must be ahead of the second best. */
const MARGIN = 0.1
/** Longer messages usually hold several questions: the AI answers those. */
const MAX_LENGTH = 60

/** Phrases that mean the same thing in a studio's chats, folded into one concept. */
const CONCEPTS: [string, RegExp][] = [
  ['預約', /預約|約堂|訂位|訂堂|留位|報名|book(?:ing)?|reserve|reservation/gi],
  ['時間表', /時間表|timetable|schedule|有咩堂|有乜堂|上堂時間|課堂時間/gi],
  ['取消', /取消|cancel|唔嚟得|唔去得|去唔到|嚟唔到|上唔到|缺席|no ?show/gi],
  ['改期', /改期|改時間|改日子|轉日子|轉第二日|轉另一日|另一日|第二日|reschedule|another (?:day|date|time)|change (?:the |my )?(?:class|booking|time|date|day)/gi],
  ['天氣', /風球|打風|颱風|掛波|八號|8號|黑雨|紅雨|黃雨|暴雨|大雨|落雨|typhoon|rainstorm|storm|signal/gi],
  ['停課', /停課|停堂|仲有冇堂|仲上唔上|照上|照常|class (?:still )?on|cancelled/gi],
  ['襪', /防滑襪|止滑襪|襪|socks?|赤腳|止滑|防滑|grip/gi],
  ['有效期', /有效期|過期|到期|幾耐內|用晒|用完|expire[sd]?|expiry|validity|valid/gi],
  ['套票', /套票|配套|package|pack\b/gi],
  // Topics with no FAQ of their own: recognising them keeps such questions away from the FAQs above.
  ['價錢', /價錢|幾錢|幾多錢|收費|費用|price|cost|how much/gi],
  ['地址', /地址|喺邊|點去|點樣去|address|location|where/gi],
  ['付款', /付款|俾錢|畀錢|找數|fps|payme|轉數快|信用卡|credit card|現金|cash/gi],
  ['泊車', /泊車|停車|車位|parking/gi],
  ['試堂', /試堂|體驗堂|trial/gi],
  ['私人班', /私人班|私人訓練|一對一|1對1|private|group pt|pt\b/gi],
  ['教練', /教練|導師|老師|instructor|coach|trainer/gi],
]

/** Grammar words that say nothing about the topic. */
const STOP_CHARS = /[我你佢哋嘅咗呢呀啊喎嗎吖啦咩嘢㗎囉喇係唔有冇想要請問同埋都就會可以點樣搞算咁個啲嚟去上堂]/g
const STOP_WORDS = new Set(['i', 'my', 'me', 'the', 'a', 'an', 'to', 'is', 'do', 'does', 'can', 'how', 'what', 'when', 'with', 'still', 'on', 'of', 'for', 'it', 'in', 'class', 'classes'])

type Vector = Map<string, number>

/** Concepts, English words and Chinese character pairs of a text, with weights. */
export function features(text: string, weight = 1): Vector {
  const v: Vector = new Map()
  const add = (k: string, w: number) => v.set(k, (v.get(k) ?? 0) + w * weight)
  let rest = text.normalize('NFKC').toLowerCase()
  for (const [name, re] of CONCEPTS) {
    if (re.test(rest)) add(`#${name}`, 3)
    re.lastIndex = 0
    rest = rest.replace(re, ' ')
  }
  for (const word of rest.match(/[a-z0-9]+/g) ?? []) if (word.length > 1 && !STOP_WORDS.has(word)) add(`w:${word}`, 1)
  for (const run of rest.replace(STOP_CHARS, ' ').match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) add(`c:${run}`, 0.5)
    for (let i = 0; i + 1 < run.length; i++) add(`b:${run.slice(i, i + 2)}`, 1)
  }
  return v
}

function merge(a: Vector, b: Vector): Vector {
  const out = new Map(a)
  for (const [k, w] of b) out.set(k, (out.get(k) ?? 0) + w)
  return out
}

function weighted(v: Vector, idf: Map<string, number>, fallback: number): Vector {
  return new Map([...v].map(([k, w]) => [k, w * (idf.get(k) ?? fallback)]))
}

function cosine(a: Vector, b: Vector) {
  let dot = 0
  for (const [k, w] of a) dot += w * (b.get(k) ?? 0)
  const norm = (v: Vector) => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0))
  const n = norm(a) * norm(b)
  return n ? dot / n : 0
}

export interface FaqEntry { id: number; title: string; body: string; keywords: string }

/** Every FAQ's similarity to the question, best first. */
export function scoreFaqs(question: string, faqs: FaqEntry[]) {
  // The question side of an FAQ is its title and keywords; the answer counts for less.
  const docs = faqs.map((f) => merge(features(`${f.title} ${f.keywords.replace(/[,，、]/g, ' ')}`), features(f.body, 0.4)))
  const df = new Map<string, number>()
  for (const d of docs) for (const k of d.keys()) df.set(k, (df.get(k) ?? 0) + 1)
  const n = Math.max(docs.length, 1)
  const idf = new Map([...df].map(([k, c]) => [k, Math.log(1 + n / c)]))
  // Words no FAQ uses still count against every FAQ: they are what the question is really about.
  const unseen = Math.log(1 + n)
  const q = weighted(features(question), idf, unseen)
  return faqs
    .map((f, i) => ({ ...f, score: cosine(q, weighted(docs[i], idf, unseen)) }))
    .sort((a, b) => b.score - a.score)
}

export function semanticThreshold() {
  const value = Number(getSetting('faq_semantic_threshold', String(DEFAULT_THRESHOLD)))
  return Number.isFinite(value) ? value : DEFAULT_THRESHOLD
}

/** The FAQ the customer is asking in other words, or undefined to let the AI answer. */
export function semanticFaq(text: string, brandId?: number | null) {
  const threshold = semanticThreshold()
  const question = text.trim()
  if (threshold <= 0 || !question || [...question].length > MAX_LENGTH) return undefined
  const faqs = all<FaqEntry>(
    // Same rules as keyword answers: active, this brand or every brand, no unfilled [placeholder].
    "SELECT id, title, body, keywords FROM knowledge WHERE active = 1 AND category = 'faq' AND instr(body, '[') = 0 AND (brand_id IS NULL OR brand_id = ?)",
    brandId ?? -1,
  )
  const [best, second] = scoreFaqs(question, faqs)
  if (!best || best.score < threshold || (second && best.score - second.score < MARGIN)) return undefined
  return { id: best.id, title: best.title, body: best.body, score: best.score }
}
