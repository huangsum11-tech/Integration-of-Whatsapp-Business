/**
 * API for the studio features: brands and their catalogue (prices, booking links, payment
 * details), guided flows, and the FPS / PayMe payment queue. Mounted inside /api after login.
 */
import fs from 'node:fs'
import path from 'node:path'
import express, { type Request } from 'express'
import { z } from 'zod'
import { requireAdmin } from './auth.js'
import { brandById, brands, branchesOf, money, type Package } from './brands.js'
import { all, get, getSetting, run, setSetting, tx } from './db.js'
import { activeFlow, endFlow, flowSummary } from './flows.js'
import { getConversation } from './inbox.js'
import {
  RETURN_MESSAGES, STATUS_LABEL, cancel, createPaymentRequest, credit, getRequest, listRequests, paymentSummary, queueCounts,
  quote, requestEvents, returnRequest, sendPaymentDetails, verify, type ReturnReason,
} from './payments.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR } from './whatsapp.js'

export const studio = express.Router()

function body<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.body)
}

const fail = (err: unknown) => ({ error: err instanceof Error ? err.message : '操作失敗' })

// ---------- Brands and catalogue ----------

/** Payment details are shown to every teammate: they need them to check the bank record. */
studio.get('/brands', (_req, res) => {
  res.json({
    brands: brands().map((b) => ({
      ...b,
      branches: branchesOf(b.id),
      trial_offers: all('SELECT * FROM trial_offers WHERE brand_id = ? ORDER BY sort, id', b.id),
      packages: all('SELECT * FROM packages WHERE brand_id = ? ORDER BY sort, id', b.id),
    })),
    settings: {
      cross_brand_mode: getSetting('cross_brand_mode', 'refer'),
      trial_flow_enabled: getSetting('trial_flow_enabled', '1') === '1',
      purchase_flow_enabled: getSetting('purchase_flow_enabled', '1') === '1',
      payment_screenshot_days: Number(getSetting('payment_screenshot_days', '90')),
    },
  })
})

studio.put('/brands/settings', requireAdmin, (req, res) => {
  const b = body(z.object({
    cross_brand_mode: z.enum(['refer', 'answer']).optional(),
    trial_flow_enabled: z.boolean().optional(),
    purchase_flow_enabled: z.boolean().optional(),
    payment_screenshot_days: z.number().int().min(0).max(3650).optional(),
  }), req)
  tx(() => {
    for (const [k, v] of Object.entries(b)) if (v !== undefined) setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  })
  res.json({ ok: true })
})

const url = z.string().max(500).refine((v) => v === '' || /^https?:\/\//.test(v), '連結要以 http:// 或 https:// 開頭')

studio.put('/brands/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({
    name: z.string().trim().min(1).max(60).optional(),
    whatsapp: z.string().max(30).optional(),
    booking_url: url.optional(),
    booking_platform: z.string().max(40).optional(),
    booking_steps: z.string().max(2000).optional(),
    fps_id: z.string().max(60).optional(),
    fps_name: z.string().max(80).optional(),
    payme_link: url.optional(),
    ref_prefix: z.string().regex(/^[A-Z]{0,4}$/, '參考編號字首只可以用 0–4 個大楷英文字母').optional(),
    after_trial_offer: z.string().max(500).optional(),
  }), req)
  if (!brandById(id)) return res.status(404).json({ error: '找不到品牌' })
  const keys = Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined)
  if (keys.length) run(`UPDATE brands SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => b[k as keyof typeof b]), id)
  res.json(brandById(id))
})

/** Upload the payment QR code or the booking-steps picture (data URL). Kept under data/media/uploads. */
studio.post('/brands/:id/image', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({ kind: z.enum(['qr', 'steps']), dataUrl: z.string().regex(/^data:image\/(png|jpe?g|webp);base64,/, '只接受 PNG、JPG 或 WebP 圖片') }), req)
  if (!brandById(id)) return res.status(404).json({ error: '找不到品牌' })
  const [, ext, data] = b.dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.*)$/)!
  const rel = path.join('uploads', `brand-${id}-${b.kind}-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`)
  fs.mkdirSync(path.join(MEDIA_DIR, 'uploads'), { recursive: true })
  fs.writeFileSync(path.join(MEDIA_DIR, rel), Buffer.from(data, 'base64'))
  run(`UPDATE brands SET ${b.kind === 'qr' ? 'payment_qr_image' : 'booking_steps_image'} = ? WHERE id = ?`, rel, id)
  res.json(brandById(id))
})

studio.delete('/brands/:id/image/:kind', requireAdmin, (req, res) => {
  const column = req.params.kind === 'qr' ? 'payment_qr_image' : 'booking_steps_image'
  run(`UPDATE brands SET ${column} = NULL WHERE id = ?`, Number(req.params.id))
  res.json(brandById(Number(req.params.id)))
})

const offer = z.object({
  branch_keys: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(80),
  price_text: z.string().trim().min(1).max(40), validity: z.string().max(40).default(''), active: z.boolean().default(true),
})
studio.post('/brands/:id/trial-offers', requireAdmin, (req, res) => {
  const b = body(offer, req)
  run('INSERT INTO trial_offers (brand_id, branch_keys, label, price_text, validity, active, sort) VALUES (?, ?, ?, ?, ?, ?, 99)',
    Number(req.params.id), b.branch_keys, b.label, b.price_text, b.validity, b.active ? 1 : 0)
  res.json({ ok: true })
})
studio.put('/trial-offers/:id', requireAdmin, (req, res) => {
  const b = body(offer, req)
  run('UPDATE trial_offers SET branch_keys = ?, label = ?, price_text = ?, validity = ?, active = ? WHERE id = ?',
    b.branch_keys, b.label, b.price_text, b.validity, b.active ? 1 : 0, Number(req.params.id))
  res.json({ ok: true })
})
studio.delete('/trial-offers/:id', requireAdmin, (req, res) => {
  run('DELETE FROM trial_offers WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

const pkg = z.object({
  category: z.string().trim().min(1).max(80), sessions: z.number().int().min(1).max(999), price: z.number().int().min(0).max(1_000_000),
  validity: z.string().max(40).default(''), backoffice_name: z.string().max(120).default(''), active: z.boolean().default(true),
})
studio.post('/brands/:id/packages', requireAdmin, (req, res) => {
  const b = body(pkg, req)
  run('INSERT INTO packages (brand_id, category, sessions, price, validity, backoffice_name, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, 999)',
    Number(req.params.id), b.category, b.sessions, b.price, b.validity, b.backoffice_name, b.active ? 1 : 0)
  res.json({ ok: true })
})
studio.put('/packages/:id', requireAdmin, (req, res) => {
  const b = body(pkg, req)
  run('UPDATE packages SET category = ?, sessions = ?, price = ?, validity = ?, backoffice_name = ?, active = ? WHERE id = ?',
    b.category, b.sessions, b.price, b.validity, b.backoffice_name, b.active ? 1 : 0, Number(req.params.id))
  res.json({ ok: true })
})
studio.delete('/packages/:id', requireAdmin, (req, res) => {
  if (get('SELECT 1 FROM payment_requests WHERE package_id = ?', Number(req.params.id))) {
    run('UPDATE packages SET active = 0 WHERE id = ?', Number(req.params.id))
    return res.json({ ok: true, archived: true })
  }
  run('DELETE FROM packages WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

/** Which brand a number belongs to. */
studio.put('/numbers/:id/brand', requireAdmin, (req, res) => {
  const { brand_id } = body(z.object({ brand_id: z.number().int().nullable() }), req)
  run('UPDATE numbers SET brand_id = ? WHERE id = ?', brand_id, Number(req.params.id))
  broadcast('number', { id: Number(req.params.id), brand_id })
  res.json({ ok: true })
})

// ---------- Flows and payments in a conversation ----------

studio.get('/conversations/:id/studio', (req, res) => {
  const id = Number(req.params.id)
  const c = getConversation(id)
  if (!c) return res.status(404).json({ error: '找不到對話' })
  const brandId = get<{ brand_id: number | null }>('SELECT brand_id FROM numbers WHERE id = ?', c.number_id)?.brand_id
  res.json({
    flow: flowSummary(id),
    brand: brandById(brandId)?.name ?? null,
    packages: brandId ? all('SELECT * FROM packages WHERE brand_id = ? AND active = 1 ORDER BY sort, id', brandId) : [],
    payments: listRequests({}).filter((r: any) => r.conversation_id === id),
  })
})

studio.post('/conversations/:id/flow/end', (req, res) => {
  const flow = activeFlow(Number(req.params.id))
  if (flow) endFlow(flow.id, 'aborted', '同事結束')
  res.json({ ok: true })
})

/** A teammate starts a purchase: listed price, or an amount they set (e.g. after a discount). */
studio.post('/conversations/:id/payments', async (req, res) => {
  const id = Number(req.params.id)
  const b = body(z.object({ package_id: z.number().int(), amount: z.number().int().min(1).optional(), note: z.string().max(200).default('') }), req)
  const c = getConversation(id)
  const brandId = c ? get<{ brand_id: number | null }>('SELECT brand_id FROM numbers WHERE id = ?', c.number_id)?.brand_id : null
  const p = get<Package>('SELECT * FROM packages WHERE id = ?', b.package_id)
  if (!c || !brandId) return res.status(400).json({ error: '這個號碼未設定品牌：請到「設定 → 品牌及收款」設定' })
  if (!p || p.brand_id !== brandId) return res.status(400).json({ error: '這個套票不屬於這個號碼的品牌' })
  try {
    const r = createPaymentRequest(id, brandId, p, b.amount ?? p.price, 'quoted', b.note || (b.amount && b.amount !== p.price ? `同事報價 ${money(b.amount)}（原價 ${money(p.price)}）` : ''))
    res.json(await sendPaymentDetails(r, req.user.id))
  } catch (err) {
    res.status(400).json(fail(err))
  }
})

// ---------- Payment queue ----------

studio.get('/payments', (req, res) => {
  res.json({
    requests: listRequests({ status: req.query.status ? String(req.query.status) : 'open', q: req.query.q ? String(req.query.q) : undefined }),
    counts: queueCounts(),
    labels: STATUS_LABEL,
    returnReasons: Object.keys(RETURN_MESSAGES),
  })
})

studio.get('/payments/summary', (_req, res) => {
  res.json({ today: paymentSummary(1), week: paymentSummary(7) })
})

studio.get('/payments/:id', (req, res) => {
  const r = getRequest(Number(req.params.id))
  if (!r) return res.status(404).json({ error: '找不到付款請求' })
  res.json({ ...r, label: STATUS_LABEL[r.status], events: requestEvents(r.id), runs: all('SELECT * FROM automation_runs WHERE request_id = ? ORDER BY id DESC', r.id) })
})

const act = (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: express.Response) => {
  try {
    res.json(await fn(req))
  } catch (err) {
    res.status(400).json(fail(err))
  }
}

studio.post('/payments/:id/quote', act((req) => quote(Number(req.params.id), body(z.object({ amount: z.number().int().min(1) }), req).amount, req.user.id)))
studio.post('/payments/:id/verify', act((req) => verify(Number(req.params.id), req.user.id)))
studio.post('/payments/:id/return', act((req) => {
  const { reason } = body(z.object({ reason: z.enum(Object.keys(RETURN_MESSAGES) as [ReturnReason]) }), req)
  return returnRequest(Number(req.params.id), reason, req.user.id)
}))
studio.post('/payments/:id/credit', act((req) => credit(Number(req.params.id), req.user.id)))
studio.post('/payments/:id/cancel', act((req) => cancel(Number(req.params.id), req.user.id, '同事取消')))

