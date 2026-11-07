/**
 * Guided conversations that must not improvise:
 * - trial: a new customer chooses a branch → a trial class → gets the brand's booking link
 *   and steps → tells us when they booked → reminders and a follow-up are scheduled.
 * - purchase: a customer chooses a package → gets the listed price → FPS / PayMe details →
 *   sends a payment screenshot → a teammate verifies (see payments.ts).
 *
 * Every price, link and payment detail comes from the brand catalogue (brands.ts) for the
 * brand the customer chose; nothing is computed or invented. Refunds, complaints, disputed
 * deductions, health questions and balance questions stop any flow and go to a person.
 */
import type { CustomerReply } from './ai.js'
import { recordTrial } from './automation.js'
import { setTags, tagsFor } from './campaigns.js'
import {
  brandById, brandOfConversation, branchByKey, branchesOf, matchBranch, money, packageLabel, packagesFor, trialOffersFor,
  type Brand, type Branch, type Package, type TrialOffer,
} from './brands.js'
import { CONTACT_NAME_SQL, all, get, getSetting, run } from './db.js'
import { addEvent, getConversation, inboxEvents } from './inbox.js'
import { attachScreenshot, createPaymentRequest, markAwaitingPayment, paymentMessage, requestForScreenshot, type PaymentRequest } from './payments.js'
import { formatLocal, localParts, parseLocal } from './time.js'

export type FlowReply = CustomerReply & { images?: string[]; flagForTeam?: string }

interface Flow { id: number; conversation_id: number; kind: 'trial' | 'purchase'; brand_id: number | null; step: string; data: string; status: string }
type Data = Record<string, any>

// ---------- What customers say ----------

/** Topics the flows never handle (spec: refunds, complaints, disputed deductions, health, balances). */
const SENSITIVE: [RegExp, string][] = [
  [/退款|退錢|退返錢|退費|refund/i, '退款'],
  [/投訴|complain|唔滿意|不滿意|好失望|好差/i, '投訴'],
  [/扣堂|扣咗|被扣|點解扣|deduct/i, '扣堂爭議'],
  [/受傷|傷患|懷孕|有孕|孕婦|手術|痛症|腰痛|背痛|膝痛|頸痛|膊頭痛|高血壓|心臟|醫生|物理治療|physio|injur|pregnan/i, '健康'],
  [/餘額|剩幾多堂|剩返幾|仲有幾多堂|仲有幾堂|還有幾堂|未用幾多堂|balance/i, '個人餘額查詢'],
]
export function sensitiveTopic(text: string) {
  return SENSITIVE.find(([re]) => re.test(text))?.[1]
}

const TRIAL_INTENT = /試堂|試玩|體驗堂|新人優惠|新學員|想試|第一次上|trial/i
const PURCHASE_INTENT = /(買|購買|續|想要|付款|俾錢|畀錢|點樣比錢).{0,8}(套票|堂|package|配套)|(fps|payme|轉數快).{0,6}(俾|畀|付|買|pay)|(pay|buy).{0,10}(package|class)/i
const YES = /^(確認|確定|ok|okay|好|好呀|好的|得|可以|冇問題|yes|y|confirm)[!！。. ]*$/i
const HELP_BOOK = /幫我訂|幫我book|代訂|代我訂|唔識|不懂|唔會用|唔知點book|help me book/i
const LINK_BROKEN = /(連結|link|網址|app).{0,6}(用唔到|打唔開|開唔到|壞|錯|error|唔work|not work)|開唔到|打唔開/i

/** "11月12日 7pm", "12/11 19:00", "聽日晚上7點", "星期六 10:30" → unix seconds (studio time zone). */
export function parseBookedTime(text: string, now = new Date()): number | null {
  const t = text.replace(/\s+/g, ' ')
  const today = localParts(now)
  let y = today.year
  let m: number | undefined
  let d: number | undefined
  const md = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/) ?? null
  const dm = !md ? t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/) : null
  if (md) { m = Number(md[1]); d = Number(md[2]) }
  else if (dm) { d = Number(dm[1]); m = Number(dm[2]); if (dm[3]) y = Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) }
  else {
    const rel = t.match(/今日|今天|聽日|明日|明天|後日|后日|後天/)
    const wk = t.match(/(?:星期|禮拜|礼拜|週|周)\s*([一二三四五六日天])/)
    let offset: number | undefined
    if (rel) offset = /今/.test(rel[0]) ? 0 : /聽|明/.test(rel[0]) ? 1 : 2
    else if (wk) {
      const target = '日一二三四五六'.indexOf(wk[1] === '天' ? '日' : wk[1])
      offset = (target - today.weekday + 7) % 7 || 7
    }
    if (offset === undefined) return null
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    y = base.getUTCFullYear(); m = base.getUTCMonth() + 1; d = base.getUTCDate()
  }
  // Look for the time only after removing the date, so "11月12日" is not read as 11 o'clock.
  const rest = t.replace(md?.[0] ?? dm?.[0] ?? '', ' ')
  const time = rest.match(/(上午|早上|朝早|中午|下午|晏晝|晚上|夜晚|夜晚黑|夜)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|[點点時]\s*(半|\d{1,2})?(?:分)?)?\s*(am|pm|a\.m\.|p\.m\.)?/i)
  if (!time || (!time[3] && !time[4] && !time[5] && !time[1] && !/[點点時]/.test(time[0]))) return null
  let hour = Number(time[2])
  const minute = time[3] ? Number(time[3]) : time[4] === '半' ? 30 : time[4] ? Number(time[4]) : 0
  const pm = /pm|p\.m\./i.test(time[5] ?? '') || /下午|晚上|夜|晏晝/.test(time[1] ?? '')
  if (pm && hour < 12) hour += 12
  if (/中午/.test(time[1] ?? '') && hour < 11) hour += 12
  if (hour > 23 || minute > 59 || !m || !d || m > 12 || d > 31) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  let at = parseLocal(`${y}-${pad(m)}-${pad(d)} ${pad(hour)}:${pad(minute)}`)
  // A date without a year that has already passed means next year.
  if (at && !dm?.[3] && at < now.getTime() / 1000 - 86400) at = parseLocal(`${y + 1}-${pad(m)}-${pad(d)} ${pad(hour)}:${pad(minute)}`)
  return at
}

/** "我叫陳小美，想星期六晚上" → "陳小美" (best effort; teammates see the full answer anyway). */
function guessName(text: string) {
  const called = text.match(/(?:我叫|叫我|我係|我是|稱呼|名字係|名叫)\s*([^\s，,。.!！、]{1,12})/)
  if (called) return called[1]
  const first = text.split(/[，,。\n\s、]/)[0].trim()
  return first.length > 0 && first.length <= 8 && !/\d|星期|禮拜|聽日|明天|今日|上午|下午|晚上/.test(first) ? first : ''
}

// ---------- Flow storage ----------

export function activeFlow(conversationId: number) {
  return get<Flow>("SELECT * FROM flows WHERE conversation_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", conversationId)
}

function save(flow: Flow, step: string, data: Data, brandId = flow.brand_id) {
  run('UPDATE flows SET step = ?, data = ?, brand_id = ?, nudged = 0, updated_at = unixepoch() WHERE id = ?', step, JSON.stringify(data), brandId, flow.id)
}

export function endFlow(flowId: number, status: 'done' | 'handoff' | 'aborted' | 'abandoned', note = '') {
  const flow = get<Flow>('SELECT * FROM flows WHERE id = ?', flowId)
  run('UPDATE flows SET status = ?, updated_at = unixepoch() WHERE id = ?', status, flowId)
  if (flow) addEvent(flow.conversation_id, null, 'flow_end', `${flow.kind === 'trial' ? '試堂引導' : '購買'}：${({ done: '完成', handoff: '轉交同事', aborted: '已中止', abandoned: '客人未有回覆，已結束' })[status]}${note ? `（${note}）` : ''}`)
}

function start(conversationId: number, kind: 'trial' | 'purchase', step: string, data: Data, brandId: number | null) {
  const id = Number(run('INSERT INTO flows (conversation_id, kind, brand_id, step, data) VALUES (?, ?, ?, ?, ?)', conversationId, kind, brandId, step, JSON.stringify(data)).lastInsertRowid)
  addEvent(conversationId, null, 'flow_start', kind === 'trial' ? '試堂引導' : 'FPS／PayMe 購買')
  return get<Flow>('SELECT * FROM flows WHERE id = ?', id)!
}

function tag(conversationId: number, add: string[], remove: string[] = []) {
  const contactId = getConversation(conversationId)?.contact_id
  if (!contactId) return
  setTags(contactId, [...tagsFor(contactId).filter((t) => !remove.includes(t)), ...add])
}

function handoff(flow: Flow, reason: string): FlowReply {
  endFlow(flow.id, 'handoff', reason)
  return { action: 'handoff', reason }
}

// ---------- Messages ----------

function branchMenu(branches: Branch[]) {
  return branches.map((b, i) => `${i + 1}. ${b.name}（${brandById(b.brand_id)?.name ?? ''}）`).join('\n')
}

function offerMenu(offers: TrialOffer[]) {
  return offers.map((o, i) => `${i + 1}. ${o.label} ${o.price_text}${o.validity ? `（${o.validity}內使用）` : ''}`).join('\n')
}

/** When a branch belongs to another brand than this number: never quote, point to the right number. */
function crossBrand(flow: Flow, numberBrand: Brand | undefined, branch: Branch): FlowReply | null {
  if (!numberBrand || branch.brand_id === numberBrand.id) return null
  if (getSetting('cross_brand_mode', 'refer') !== 'refer') return null
  const other = brandById(branch.brand_id)!
  endFlow(flow.id, 'handoff', `客人想去 ${branch.name}（${other.name}）`)
  return {
    action: 'reply',
    text: `${branch.name}屬於 ${other.name}，價錢同預約由 ${other.name} 負責 😊 請 WhatsApp ${other.name}：${other.whatsapp}，同事會為你安排。`,
    flagForTeam: `客人查詢 ${branch.name}（${other.name}），已提供 ${other.name} WhatsApp`,
  }
}

// ---------- Trial flow ----------

function startTrial(conversationId: number): FlowReply {
  const numberBrand = brandOfConversation(conversationId)
  const branches = branchesOf()
  tag(conversationId, ['新生-試堂中'])
  const flow = start(conversationId, 'trial', 'branch', {}, numberBrand?.id ?? null)
  if (branches.length === 1) return trialStep(flow, branches[0].name)
  return {
    action: 'reply',
    text: `你好！歡迎嚟試堂 😊 想去邊間分店？\n${branchMenu(branches)}\n回覆分店名或者號碼就得。`,
  }
}

function trialStep(flow: Flow, text: string): FlowReply {
  const data: Data = JSON.parse(flow.data)
  const numberBrand = brandById(flow.brand_id)
  const conversationId = flow.conversation_id

  if (flow.step === 'branch') {
    const branches = branchesOf()
    const branch = matchBranch(text, branches)
    if (!branch) return { action: 'reply', text: `想去邊間分店呢？\n${branchMenu(branches)}` }
    const refer = crossBrand(flow, numberBrand, branch)
    if (refer) return refer
    const offers = trialOffersFor(branch.brand_id, branch.key)
    if (offers.length === 0) return handoff(flow, `${branch.name}未有試堂項目資料`)
    save(flow, 'offer', { ...data, branch: branch.key }, branch.brand_id)
    return {
      action: 'reply',
      text: `${branch.name}可以試以下課堂（新學員專享，每位只限用一次）：\n${offerMenu(offers)}\n想試邊一個？回覆號碼就得。`,
    }
  }

  const branch = branchByKey(data.branch)!
  const brand = brandById(branch.brand_id)!
  const offers = trialOffersFor(brand.id, branch.key)

  if (flow.step === 'offer') {
    const n = Number(text.match(/\d+/)?.[0])
    const offer = (n && offers[n - 1]) || offers.find((o) => text.toLowerCase().includes(o.label.toLowerCase()))
    if (!offer) return { action: 'reply', text: `想試邊一個呢？\n${offerMenu(offers)}` }
    save(flow, 'info', { ...data, offer: offer.id })
    return { action: 'reply', text: `好呀，${offer.label} ${offer.price_text} 😊\n請問點稱呼你？想上邊日、大約幾點？（電話會用你而家 WhatsApp 嘅號碼）` }
  }

  const offer = offers.find((o) => o.id === data.offer)
  if (!offer) return handoff(flow, '試堂項目已更改，請同事跟進')

  if (flow.step === 'info') {
    const name = guessName(text)
    if (name) run('UPDATE contacts SET name = COALESCE(name, ?) WHERE id = (SELECT contact_id FROM conversations WHERE id = ?)', name, conversationId)
    save(flow, 'booking', { ...data, name, preference: text })
    if (!brand.booking_url) return handoff(flow, `${brand.name} 預約連結未設定`)
    const steps = brand.booking_steps.trim()
    return {
      action: 'reply',
      text: `多謝${name ? ` ${name}` : ''}！請用以下連結${brand.booking_platform ? `喺 ${brand.booking_platform} ` : ''}預約 ${branch.name} 嘅 ${offer.label}：\n${brand.booking_url}\n${steps ? `\n預約步驟：\n${steps}\n` : ''}\n預約好之後，話我知日期同時間，我會喺上堂前提你 😊\n如果唔識操作，回覆「幫我訂」，同事會幫你安排。`,
      images: brand.booking_steps_image ? [brand.booking_steps_image] : undefined,
    }
  }

  if (flow.step === 'booking') {
    if (LINK_BROKEN.test(text)) return handoff(flow, `客人話 ${brand.name} 預約連結用唔到（請即跟進）`)
    if (HELP_BOOK.test(text)) return handoff(flow, `客人要求代訂：${data.name || ''} ${branch.name} ${offer.label}，想上：${data.preference ?? ''}`)
    const at = parseBookedTime(text)
    if (!at) {
      const tries = (data.tries ?? 0) + 1
      if (tries >= 3) return handoff(flow, '未能確認試堂時間')
      save(flow, 'booking', { ...data, tries })
      return { action: 'reply', text: '預約好未呀？請話我知你預約咗邊日、幾點（例如：11月12日 晚上7點）😊' }
    }
    if (at < Date.now() / 1000) return { action: 'reply', text: '呢個時間好似已經過咗，請再確認一次你預約咗邊日、幾點 🙏' }
    const trialId = recordTrial(conversationId, at, `${offer.label}（${branch.name}）`, 'ai', null)
    run('UPDATE trials SET brand_id = ?, branch_key = ? WHERE id = ?', brand.id, branch.key, trialId)
    tag(conversationId, ['已預約試堂'], ['新生-試堂中'])
    endFlow(flow.id, 'done')
    const socks = /reformer|chair/i.test(offer.label) ? '\nReformer 課要穿防滑襪（分店有售）。' : ''
    return {
      action: 'reply',
      text: `收到！已記錄你 ${formatLocal(at)} 喺${branch.name}嘅 ${offer.label} 😊\n地址：${branch.address}${socks}\n上堂前一日同 2 小時前我會提你。`,
    }
  }
  return handoff(flow, '試堂流程狀態不明')
}

// ---------- Purchase flow ----------

function categories(packages: Package[]) {
  return [...new Set(packages.map((p) => p.category))]
}

function startPurchase(conversationId: number): FlowReply {
  const brand = brandOfConversation(conversationId)
  if (!brand) {
    const flow = start(conversationId, 'purchase', 'branch', {}, null)
    return { action: 'reply', text: `想買邊間分店嘅套票？\n${branchMenu(branchesOf())}` }
  }
  const flow = start(conversationId, 'purchase', 'category', {}, brand.id)
  return categoryPrompt(flow, brand)
}

function categoryPrompt(flow: Flow, brand: Brand): FlowReply {
  const cats = categories(packagesFor(brand.id))
  if (cats.length === 0) return handoff(flow, `${brand.name} 未有套票資料`)
  return { action: 'reply', text: `${brand.name} 套票可以用 FPS／PayMe 付款 😊 想買邊類？\n${cats.map((c, i) => `${i + 1}. ${c}`).join('\n')}` }
}

/** Customer mentions or qualifies for a discount whose final price is not listed: a teammate quotes. */
function discountNote(conversationId: number, text: string) {
  const contactId = getConversation(conversationId)?.contact_id
  const recentTrial = get<{ class_at: number }>(
    "SELECT class_at FROM trials WHERE contact_id = ? AND status = 'booked' AND class_at <= unixepoch() AND class_at > unixepoch() - 86400",
    contactId,
  )
  if (recentTrial) return '試堂後 24 小時內購買'
  if (/優惠|折|discount|off|同行|朋友一齊|續堂|續套票|11\.11|雙十一/i.test(text)) return `客人提及優惠：「${text.slice(0, 60)}」`
  return ''
}

function purchaseStep(flow: Flow, text: string): FlowReply {
  const data: Data = JSON.parse(flow.data)
  const conversationId = flow.conversation_id
  const numberBrand = brandOfConversation(conversationId)

  if (flow.step === 'branch') {
    const branch = matchBranch(text, branchesOf())
    if (!branch) return { action: 'reply', text: `想買邊間分店嘅套票？\n${branchMenu(branchesOf())}` }
    const refer = crossBrand(flow, numberBrand, branch)
    if (refer) return refer
    const brand = brandById(branch.brand_id)!
    save(flow, 'category', data, brand.id)
    return categoryPrompt({ ...flow, brand_id: brand.id }, brand)
  }

  const brand = brandById(flow.brand_id)
  if (!brand) return handoff(flow, '未知品牌')
  const packages = packagesFor(brand.id)
  const cats = categories(packages)

  if (flow.step === 'category') {
    const n = Number(text.match(/^\s*(\d)\s*$/)?.[1])
    const cat = (n && cats[n - 1]) || cats.find((c) => c.split(/[\s／]/).some((w) => w.length > 1 && text.toLowerCase().includes(w.toLowerCase())))
    if (!cat) return categoryPrompt(flow, brand)
    const options = packages.filter((p) => p.category === cat)
    save(flow, 'package', { ...data, category: cat, discount: data.discount || discountNote(conversationId, text) })
    return {
      action: 'reply',
      text: `${cat}：\n${options.map((p, i) => `${i + 1}. ${p.sessions} 堂 ${money(p.price)}${p.validity ? `（有效期 ${p.validity}）` : ''}`).join('\n')}\n想要邊個？回覆號碼就得。`,
    }
  }

  if (flow.step === 'package') {
    const options = packages.filter((p) => p.category === data.category)
    const n = Number(text.match(/(\d+)/)?.[1])
    const pkg = options.find((p) => new RegExp(`(^|\\D)${p.sessions}\\s*堂`).test(text)) ?? (n && n <= options.length ? options[n - 1] : undefined)
    if (!pkg) return { action: 'reply', text: `想要邊個呢？\n${options.map((p, i) => `${i + 1}. ${p.sessions} 堂 ${money(p.price)}`).join('\n')}` }
    const discount = data.discount || discountNote(conversationId, text)
    if (discount) {
      // The discounted price is not listed: never compute it. A teammate quotes the amount.
      const request = createPaymentRequest(conversationId, brand.id, pkg, null, 'pending_quote', discount)
      save(flow, 'awaiting_quote', { ...data, request: request.id })
      return {
        action: 'reply',
        text: `${packageLabel(pkg)} 原價 ${money(pkg.price)}。你可能符合優惠（${discount.startsWith('客人') ? '你提及嘅優惠' : discount}），實際應付金額以同事確認為準，同事確認後會即刻話你知 🙏`,
        flagForTeam: `請為 ${request.ref} 報價（${discount}）`,
      }
    }
    save(flow, 'confirm', { ...data, package: pkg.id })
    return { action: 'reply', text: `${packageLabel(pkg)} ${money(pkg.price)}${pkg.validity ? `（有效期 ${pkg.validity}）` : ''}。\n確認購買？回覆「確認」我就發付款資料畀你。` }
  }

  if (flow.step === 'confirm') {
    const pkg = packages.find((p) => p.id === data.package)
    if (!pkg) return handoff(flow, '套票資料已更改')
    if (!YES.test(text.trim())) {
      if (/唔要|取消|cancel|不了|唔買/i.test(text)) { endFlow(flow.id, 'aborted', '客人取消'); return { action: 'reply', text: '冇問題，有需要隨時搵我哋 😊' } }
      return { action: 'reply', text: '確認購買嘅話，回覆「確認」就得；唔要可以回覆「取消」。' }
    }
    const request = createPaymentRequest(conversationId, brand.id, pkg, pkg.price, 'quoted', '')
    save(flow, 'paying', { ...data, request: request.id })
    const reply = paymentDetails(flow, brand, request)
    if (reply.action === 'reply') markAwaitingPayment(request.id)
    return reply
  }

  if (flow.step === 'awaiting_quote' || flow.step === 'paying') {
    // Payment screenshots are handled by payments.ts; other questions go to the normal AI.
    return { action: 'reply', text: '' }
  }
  return handoff(flow, '購買流程狀態不明')
}

/** Brand's own FPS / PayMe details; never another brand's, never invented. */
export function paymentDetails(flow: Flow | null, brand: Brand, request: PaymentRequest): FlowReply {
  const message = paymentMessage(brand, request)
  if (!message) {
    if (flow) endFlow(flow.id, 'handoff', `${brand.name} 收款資料未設定`)
    return { action: 'handoff', reason: `${brand.name} 收款資料未設定（${request.ref}）` }
  }
  return { action: 'reply', text: message, images: brand.payment_qr_image ? [brand.payment_qr_image] : undefined }
}

// ---------- Entry point ----------

/**
 * Called before the normal AI reply. Returns a reply when a flow handles the message,
 * or null to let the AI answer as usual.
 */
export function handleFlows(conversationId: number, pending: { id: number; type: string; body: string; transcript: string | null }[]): FlowReply | null {
  // A payment screenshot was just queued for checking: acknowledge, never confirm.
  const paid = requestForScreenshot(pending.map((m) => m.id))
  if (paid) {
    return {
      action: 'reply',
      text: `收到你嘅付款截圖 🙏（參考編號 ${paid.ref}）同事核實後會通知你。`,
      flagForTeam: `付款截圖待核實：${paid.ref}`,
    }
  }
  const text = pending.filter((m) => m.type === 'text' || m.transcript).map((m) => m.transcript ?? m.body).reverse().join('\n').trim()
  const flow = activeFlow(conversationId)
  const topic = text ? sensitiveTopic(text) : undefined
  if (topic) {
    if (flow) endFlow(flow.id, 'aborted', `客人提及${topic}`)
    // Payment requests wait for a person too.
    return { action: 'handoff', reason: `客人提及${topic}，需要同事處理` }
  }
  if (flow) {
    if (!text) return null
    const reply = flow.kind === 'trial' ? trialStep(flow, text) : purchaseStep(flow, text)
    return reply.action === 'reply' && !reply.text ? null : reply
  }
  if (!text) return null
  // Only for customers who have not booked a trial before.
  const contactId = getConversation(conversationId)?.contact_id
  const hadTrial = get('SELECT 1 FROM trials WHERE contact_id = ?', contactId)
  if (getSetting('trial_flow_enabled', '1') === '1' && !hadTrial && TRIAL_INTENT.test(text)) return startTrial(conversationId)
  if (getSetting('purchase_flow_enabled', '1') === '1' && PURCHASE_INTENT.test(text)) return startPurchase(conversationId)
  return null
}

/** Screenshots arrive in any reply mode (even when the AI is off): attach them right away. */
inboxEvents.on('customer-message', ({ conversationId, messageId }: { conversationId: number; messageId: number }) => {
  const m = get<{ type: string }>('SELECT type FROM messages WHERE id = ?', messageId)
  if (m?.type === 'image' || m?.type === 'document') attachScreenshot(conversationId, messageId)
})

/** Flows waiting on a customer for 24 hours get one nudge; 24 hours later they end (tags kept). */
export async function flowTimeouts(send: (conversationId: number, text: string) => Promise<void>) {
  for (const f of all<Flow & { updated_at: number; nudged: number }>(
    "SELECT * FROM flows WHERE status = 'active' AND step NOT IN ('awaiting_quote','paying') AND updated_at < unixepoch() - 86400",
  )) {
    if (!f.nudged) {
      const text = f.kind === 'trial' ? '仲想預約試堂嗎？有咩問題隨時問我 😊' : '仲想購買套票嗎？有咩問題隨時問我 😊'
      try { await send(f.conversation_id, text) } catch { /* outside the 24-hour window: the flow just ends later */ }
      run('UPDATE flows SET nudged = 1, updated_at = unixepoch() WHERE id = ?', f.id)
    } else {
      endFlow(f.id, 'abandoned')
    }
  }
}

export function flowSummary(conversationId: number) {
  const flow = activeFlow(conversationId)
  if (!flow) return null
  const data: Data = JSON.parse(flow.data)
  const contact = get<{ name: string }>(`SELECT ${CONTACT_NAME_SQL} AS name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?`, conversationId)
  return { ...flow, data, brand: brandById(flow.brand_id)?.name ?? null, contact: contact?.name }
}
