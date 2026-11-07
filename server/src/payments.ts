/**
 * FPS / PayMe purchases. Baton quotes listed prices, sends the brand's own payment details,
 * receives the customer's payment screenshot and keeps the queue for teammates. The money
 * goes straight to the studio; a teammate checks the bank / FPS record and adds the package
 * in the booking system's back office.
 *
 *   已報價 quoted → 待付款 awaiting_payment → 待核實 awaiting_verification → 已核實 verified
 *     → 已入帳 credited → 已通知客人 notified
 *   exceptions: 金額不符 amount_mismatch, 截圖不清 unclear, 找不到入帳 not_found,
 *               逾時未付 overdue (24 h), 已取消 cancelled (48 h after the reminder)
 *   pending_quote 待同事報價: a discount applies whose price is not listed.
 *
 * Iron rule: the customer is only ever told the package is active from credit(), which
 * refuses unless a teammate verified the payment.
 */
import fs from 'node:fs'
import path from 'node:path'
import { brandById, money, packageLabel, type Brand, type Package } from './brands.js'
import { sendImage, sendReply } from './channels.js'
import { CONTACT_NAME_SQL, all, get, getSetting, run, tx } from './db.js'
import { addEvent, getConversation } from './inbox.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR } from './whatsapp.js'

export type PaymentStatus =
  | 'pending_quote' | 'quoted' | 'awaiting_payment' | 'awaiting_verification' | 'verified' | 'credited' | 'notified'
  | 'amount_mismatch' | 'unclear' | 'not_found' | 'overdue' | 'cancelled'

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending_quote: '待同事報價', quoted: '已報價', awaiting_payment: '待付款', awaiting_verification: '待核實',
  verified: '已核實', credited: '已入帳', notified: '已通知客人', amount_mismatch: '金額不符', unclear: '截圖不清',
  not_found: '找不到入帳', overdue: '逾時未付', cancelled: '已取消',
}

export interface PaymentRequest {
  id: number; ref: string; conversation_id: number; contact_id: number; brand_id: number; package_id: number | null
  package_label: string; listed_price: number | null; amount: number | null; status: PaymentStatus; discount_note: string
  screenshot_message_id: number | null; verified_by: number | null; verified_at: number | null
  credited_by: number | null; credited_at: number | null; notified_at: number | null; return_reason: string | null
  reminded_at: number | null; created_at: number; updated_at: number
}

/** Statuses in which a new screenshot from the customer is accepted for checking. */
const ACCEPTS_SCREENSHOT: PaymentStatus[] = ['awaiting_payment', 'overdue', 'amount_mismatch', 'unclear', 'not_found']
const OPEN: PaymentStatus[] = ['pending_quote', 'quoted', 'awaiting_payment', 'awaiting_verification', 'verified', 'credited', ...ACCEPTS_SCREENSHOT]

export const RETURN_MESSAGES = {
  amount_mismatch: (r: PaymentRequest) => `你好，我哋核對到付款金額同應付金額 ${r.amount != null ? money(r.amount) : ''} 唔一致，麻煩補付差額或者再確認一次，然後傳新嘅付款截圖畀我 🙏（參考編號 ${r.ref}）`,
  unclear: (r: PaymentRequest) => `你好，付款截圖唔太清楚，麻煩再傳一張清楚啲嘅截圖（要見到金額、時間同備註）🙏（參考編號 ${r.ref}）`,
  not_found: (r: PaymentRequest) => `你好，我哋暫時未見到呢筆入帳（參考編號 ${r.ref}），麻煩確認付款係咪已完成，並再傳付款紀錄截圖畀我 🙏`,
} as const
export type ReturnReason = keyof typeof RETURN_MESSAGES

export const getRequest = (id: number) => get<PaymentRequest>('SELECT * FROM payment_requests WHERE id = ?', id)

function transition(r: PaymentRequest, to: PaymentStatus, userId: number | null, note = '', extra: Record<string, unknown> = {}) {
  const sets = Object.keys(extra).map((k) => `${k} = ?`)
  run(`UPDATE payment_requests SET status = ?, updated_at = unixepoch()${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = ?`, to, ...Object.values(extra), r.id)
  run('INSERT INTO payment_events (request_id, user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)', r.id, userId, r.status, to, note)
  addEvent(r.conversation_id, userId, 'payment', `${r.ref} ${STATUS_LABEL[to]}${note ? `：${note}` : ''}`)
  broadcast('payment', { id: r.id })
  return getRequest(r.id)!
}

function newRef(brand: Brand) {
  for (;;) {
    const ref = `${brand.ref_prefix || 'PAY'}-${Math.floor(1000 + Math.random() * 9000)}`
    if (!get('SELECT 1 FROM payment_requests WHERE ref = ?', ref)) return ref
  }
}

export function createPaymentRequest(conversationId: number, brandId: number, pkg: Package, amount: number | null, status: 'quoted' | 'pending_quote', discountNote: string) {
  const conversation = getConversation(conversationId)!
  const brand = brandById(brandId)!
  if (pkg.brand_id !== brandId) throw new Error('套票不屬於這個品牌')
  const ref = newRef(brand)
  const id = Number(run(
    `INSERT INTO payment_requests (ref, conversation_id, contact_id, brand_id, package_id, package_label, listed_price, amount, status, discount_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ref, conversationId, conversation.contact_id, brandId, pkg.id, packageLabel(pkg), pkg.price, amount, status, discountNote,
  ).lastInsertRowid)
  run('INSERT INTO payment_events (request_id, to_status, note) VALUES (?, ?, ?)', id, status, discountNote)
  addEvent(conversationId, null, 'payment', `${ref} ${STATUS_LABEL[status]}：${packageLabel(pkg)}${amount != null ? ` ${money(amount)}` : ''}`)
  broadcast('payment', { id })
  return getRequest(id)!
}

/** The brand's own payment details, or '' if none are set (then a person takes over). */
export function paymentMessage(brand: Brand, r: PaymentRequest) {
  if (r.amount == null || (!brand.fps_id && !brand.payme_link)) return ''
  const lines = [
    `請用以下方式付款 ${money(r.amount)}（${r.package_label}）：`,
    brand.fps_id ? `FPS 轉數快：${brand.fps_id}${brand.fps_name ? `（收款人：${brand.fps_name}）` : ''}` : '',
    brand.payme_link ? `PayMe：${brand.payme_link}` : '',
    `付款備註請填：你的電話號碼 + 參考編號 ${r.ref}`,
    '付款後請將付款截圖傳畀我，同事核實後會通知你 🙏',
  ]
  return lines.filter(Boolean).join('\n')
}

/** Send the payment details and move to 待付款. Used after the customer confirms, or a teammate quotes. */
export async function sendPaymentDetails(r: PaymentRequest, userId: number | null) {
  const brand = brandById(r.brand_id)!
  const text = paymentMessage(brand, r)
  if (!text) throw new Error(`${brand.name} 收款資料未設定：請到「設定 → 品牌及收款」填寫 FPS／PayMe`)
  await sendReply(r.conversation_id, text, { userId, aiAuto: userId === null })
  if (brand.payment_qr_image) await sendImage(r.conversation_id, brand.payment_qr_image, `${brand.name} 收款 QR`, { userId, aiAuto: userId === null }).catch(() => {})
  return transition(r, 'awaiting_payment', userId)
}

/** The flow sent the payment details itself: record that the request now awaits payment. */
export function markAwaitingPayment(id: number) {
  const r = getRequest(id)
  if (r && r.status === 'quoted') transition(r, 'awaiting_payment', null)
}

/** A screenshot from the customer: attach it to their open request and queue it for checking. */
export function attachScreenshot(conversationId: number, messageId: number) {
  const r = get<PaymentRequest>(
    `SELECT * FROM payment_requests WHERE conversation_id = ? AND status IN (${ACCEPTS_SCREENSHOT.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
    conversationId, ...ACCEPTS_SCREENSHOT,
  )
  if (!r || r.screenshot_message_id === messageId) return null
  run('UPDATE conversations SET needs_human = 1 WHERE id = ?', conversationId)
  return transition(r, 'awaiting_verification', null, '已收付款截圖', { screenshot_message_id: messageId, return_reason: null })
}

/** The request whose screenshot just arrived (for the flow's acknowledgement). */
export function requestForScreenshot(messageIds: number[]) {
  if (!messageIds.length) return undefined
  return get<PaymentRequest>(`SELECT * FROM payment_requests WHERE screenshot_message_id IN (${messageIds.map(() => '?').join(',')}) AND status = 'awaiting_verification'`, ...messageIds)
}

// ---------- Teammate actions ----------

function must(r: PaymentRequest | undefined, allowed: PaymentStatus[]) {
  if (!r) throw new Error('找不到付款請求')
  if (!allowed.includes(r.status)) throw new Error(`目前狀態「${STATUS_LABEL[r.status]}」不能做這個動作`)
  return r
}

/** A teammate sets the amount (discounts whose price is not listed), then the details go out. */
export async function quote(id: number, amount: number, userId: number) {
  const r = must(getRequest(id), ['pending_quote'])
  const quoted = transition(r, 'quoted', userId, `報價 ${money(amount)}`, { amount })
  run("UPDATE flows SET step = 'paying', updated_at = unixepoch() WHERE conversation_id = ? AND kind = 'purchase' AND status = 'active'", r.conversation_id)
  return sendPaymentDetails(quoted, userId)
}

export function verify(id: number, userId: number) {
  const r = must(getRequest(id), ['awaiting_verification'])
  run('UPDATE conversations SET needs_human = 0 WHERE id = ?', r.conversation_id)
  return transition(r, 'verified', userId, '核實通過', { verified_by: userId, verified_at: Math.floor(Date.now() / 1000) })
}

export async function returnRequest(id: number, reason: ReturnReason, userId: number) {
  const r = must(getRequest(id), ['awaiting_verification'])
  const updated = transition(r, reason, userId, `退回：${STATUS_LABEL[reason]}`, { return_reason: reason })
  await sendReply(r.conversation_id, RETURN_MESSAGES[reason](updated), { userId })
  return updated
}

/**
 * The package was added in the back office. Only now, and only for a request a teammate
 * verified, is the customer told it is active.
 */
export async function credit(id: number, userId: number) {
  const r = must(getRequest(id), ['verified'])
  if (!r.verified_by || !r.verified_at) throw new Error('未經同事核實，不能通知客人已生效')
  const credited = transition(r, 'credited', userId, '已在後台加入套票', { credited_by: userId, credited_at: Math.floor(Date.now() / 1000) })
  const brand = brandById(r.brand_id)!
  const where = brand.booking_platform ? `喺 ${brand.booking_platform} ` : ''
  await sendReply(r.conversation_id, `多謝！你嘅 ${r.package_label} 已經生效 ✅\n之後可以${where}直接預約課堂${brand.booking_url ? `：${brand.booking_url}` : '。'}`, { userId })
  run("UPDATE flows SET status = 'done', updated_at = unixepoch() WHERE conversation_id = ? AND kind = 'purchase' AND status = 'active'", r.conversation_id)
  return transition(credited, 'notified', userId, '已通知客人', { notified_at: Math.floor(Date.now() / 1000) })
}

export function cancel(id: number, userId: number | null, note = '') {
  const r = must(getRequest(id), OPEN.filter((s) => s !== 'credited'))
  run("UPDATE flows SET status = 'aborted', updated_at = unixepoch() WHERE conversation_id = ? AND kind = 'purchase' AND status = 'active'", r.conversation_id)
  return transition(r, 'cancelled', userId, note)
}

// ---------- Queue, history, summary ----------

export function listRequests(filter: { status?: string; q?: string }) {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status === 'open') where.push(`r.status IN (${OPEN.map(() => '?').join(',')})`), params.push(...OPEN)
  else if (filter.status) where.push('r.status = ?'), params.push(filter.status)
  if (filter.q) {
    where.push(`(r.ref LIKE ? OR r.package_label LIKE ? OR ${CONTACT_NAME_SQL} LIKE ? OR ct.phone LIKE ?)`)
    params.push(...Array(4).fill(`%${filter.q}%`))
  }
  return all(
    `SELECT r.*, b.name AS brand_name, ${CONTACT_NAME_SQL} AS contact_name, ct.phone,
       m.media_path AS screenshot, m.ts AS screenshot_at, v.name AS verified_by_name, c2.name AS credited_by_name
     FROM payment_requests r
     JOIN brands b ON b.id = r.brand_id
     JOIN contacts ct ON ct.id = r.contact_id
     LEFT JOIN messages m ON m.id = r.screenshot_message_id
     LEFT JOIN users v ON v.id = r.verified_by
     LEFT JOIN users c2 ON c2.id = r.credited_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE r.status WHEN 'awaiting_verification' THEN 0 WHEN 'pending_quote' THEN 1 WHEN 'verified' THEN 2 ELSE 3 END, r.updated_at ASC
     LIMIT 300`,
    ...params,
  )
}

export function requestEvents(id: number) {
  return all('SELECT e.*, u.name AS user_name FROM payment_events e LEFT JOIN users u ON u.id = e.user_id WHERE request_id = ? ORDER BY ts, id', id)
}

/** Internal summary only: counts and totals, no customer list. */
export function paymentSummary(sinceDays: number) {
  return all<{ brand: string; count: number; total: number }>(
    `SELECT b.name AS brand, COUNT(*) AS count, COALESCE(SUM(r.amount), 0) AS total
     FROM payment_requests r JOIN brands b ON b.id = r.brand_id
     WHERE r.verified_at >= unixepoch() - ? * 86400 GROUP BY b.id ORDER BY b.sort`,
    sinceDays,
  )
}

export function queueCounts() {
  return get<{ verify: number; quote: number; credit: number }>(
    `SELECT SUM(status = 'awaiting_verification') AS verify, SUM(status = 'pending_quote') AS quote, SUM(status = 'verified') AS credit
     FROM payment_requests`,
  )!
}

// ---------- Timers ----------

/**
 * 待付款 for 24 h → one reminder and 逾時未付; 48 h after that → 已取消 and the team is told.
 * Screenshots older than the retention period are deleted from disk.
 */
export async function paymentTimers() {
  for (const r of all<PaymentRequest>("SELECT * FROM payment_requests WHERE status = 'awaiting_payment' AND updated_at < unixepoch() - 86400")) {
    await sendReply(r.conversation_id, `提提你：${r.package_label}${r.amount != null ? ` ${money(r.amount)}` : ''} 仲未收到付款截圖（參考編號 ${r.ref}）。付款後傳截圖畀我就得 😊`, { userId: null, aiAuto: true })
      .catch(() => { /* outside the 24-hour window; the request still times out */ })
    transition(r, 'overdue', null, '24 小時未收到付款截圖，已提醒客人', { reminded_at: Math.floor(Date.now() / 1000) })
  }
  for (const r of all<PaymentRequest>("SELECT * FROM payment_requests WHERE status = 'overdue' AND reminded_at < unixepoch() - 2 * 86400")) {
    cancel(r.id, null, '提醒後 48 小時仍未付款，自動取消')
    run('UPDATE conversations SET needs_human = 1 WHERE id = ?', r.conversation_id)
  }

  const days = Number(getSetting('payment_screenshot_days', '90'))
  if (days > 0) {
    for (const m of all<{ id: number; media_path: string }>(
      `SELECT m.id, m.media_path FROM payment_requests r JOIN messages m ON m.id = r.screenshot_message_id
       WHERE m.media_path IS NOT NULL AND m.ts < unixepoch() - ? * 86400`,
      days,
    )) {
      tx(() => {
        fs.rmSync(path.join(MEDIA_DIR, m.media_path), { force: true })
        run('UPDATE messages SET media_path = NULL WHERE id = ?', m.id)
      })
    }
  }
}
