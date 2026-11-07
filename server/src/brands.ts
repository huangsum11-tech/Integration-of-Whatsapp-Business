/**
 * Brands, branches, first-trial offers and packages. Each WhatsApp number belongs to one
 * brand, and a conversation only ever sees its own brand's prices, booking link and
 * payment details: Fuse Fitness and Fuse Pilates must never be mixed.
 *
 * First run seeds the catalogue from 《FUSE 基本資料 Business Info.md》(2026-11-03). Prices
 * are copied exactly; discounts are never computed here. Booking links and payment details
 * are left blank until the studio provides them, and the flows hand off to a person meanwhile.
 */
import { all, get, run, tx } from './db.js'

export interface Brand {
  id: number; key: string; name: string; whatsapp: string
  booking_url: string; booking_platform: string; booking_steps: string; booking_steps_image: string | null
  fps_id: string; fps_name: string; payme_link: string; payment_qr_image: string | null; ref_prefix: string
  after_trial_offer: string
}
export interface Branch { id: number; brand_id: number; key: string; name: string; aliases: string; address: string }
export interface TrialOffer { id: number; brand_id: number; branch_keys: string; label: string; price_text: string; validity: string }
export interface Package { id: number; brand_id: number; category: string; sessions: number; price: number; validity: string; backoffice_name: string }

const DEFAULT_STEPS = `① 打開預約連結
② 註冊／登入（用你的電話號碼）
③ 揀分店同課堂
④ 揀日子同時間
⑤ 確認預約`

const VALIDITY: Record<number, string> = { 1: '1 星期', 4: '4 星期', 8: '10 星期', 12: '15 星期', 20: '25 星期' }

/** 《FUSE 基本資料 Business Info.md》2026-11-03, section 1–2. */
const SEED = {
  brands: [
    { key: 'fitness', name: 'Fuse Fitness', whatsapp: '6338 8653', ref_prefix: 'FF', branches: [
      { key: 'skw', name: '筲箕灣', aliases: 'SKW, shau kei wan, 筲箕湾', address: '筲箕灣望隆街一號合隆工廠大廈 15B' },
    ] },
    { key: 'pilates', name: 'Fuse Pilates', whatsapp: '5405 4224', ref_prefix: 'FP', branches: [
      { key: 'spk', name: '新蒲崗', aliases: 'SPK, san po kong, 新蒲岗', address: '新蒲崗大有街 3 號萬迪廣場 20 樓 H 室' },
      { key: 'kt', name: '觀塘', aliases: 'KT, kwun tong, 观塘', address: '觀塘巧明街 115 號柏秀中心 13B' },
    ] },
  ],
  trials: {
    fitness: [
      ['skw', '恆常小組 1 堂', '$120', '1 星期'], ['skw', '恆常小組 3 堂', '$330', '3 星期'],
      ['skw', 'Reformer 1 堂', '$220', '1 星期'], ['skw', 'Reformer 3 堂', '$600', '3 星期'],
      ['skw', '私人訓練 一對一 首堂', '$400', ''], ['skw', '私人訓練 一對二 首堂', '$600', ''],
    ],
    pilates: [
      ['spk,kt', 'Reformer 1 堂', '$220', '1 星期'], ['spk,kt', 'Reformer 3 堂', '$600', '3 星期'],
      ['spk,kt', '私人訓練 一對一 首堂', '$400', ''], ['spk,kt', '私人訓練 一對二 首堂', '$600', ''],
    ],
  },
  packages: {
    fitness: [
      ['恆常小組訓練', [200, 680, 1280, 1800, 2800]],
      ['普拉提核心床 Reformer', [320, 1120, 2080, 3000, 4600]],
      ['私人訓練 一對一', [650, 2400, 4600, 6600, 10500]],
      ['私人訓練 一對二', [880, 3280, 6240, 8880, 14000]],
    ],
    pilates: [
      ['恆常小組班 Reformer／Elevate Chair', [320, 1120, 2080, 3000, 4600]],
      ['一對一私人班', [750, 2880, 5600, 8160, 13000]],
      ['一對二私人班', [950, 3600, 6960, 10200, 16400]],
    ],
  },
} as const

/** Seed the catalogue on first run, and link the two numbers to their brands. */
export function seedCatalogue() {
  if (get('SELECT id FROM brands LIMIT 1')) return
  tx(() => {
    SEED.brands.forEach((b, bi) => {
      const brandId = Number(run(
        'INSERT INTO brands (key, name, whatsapp, ref_prefix, booking_steps, sort) VALUES (?, ?, ?, ?, ?, ?)',
        b.key, b.name, b.whatsapp, b.ref_prefix, DEFAULT_STEPS, bi,
      ).lastInsertRowid)
      b.branches.forEach((br, i) => run('INSERT INTO branches (brand_id, key, name, aliases, address, sort) VALUES (?, ?, ?, ?, ?, ?)', brandId, br.key, br.name, br.aliases, br.address, i))
      SEED.trials[b.key].forEach(([keys, label, price, validity], i) =>
        run('INSERT INTO trial_offers (brand_id, branch_keys, label, price_text, validity, sort) VALUES (?, ?, ?, ?, ?, ?)', brandId, keys, label, price, validity, i))
      let sort = 0
      for (const [category, prices] of SEED.packages[b.key]) {
        ;[1, 4, 8, 12, 20].forEach((sessions, i) =>
          run('INSERT INTO packages (brand_id, category, sessions, price, validity, sort) VALUES (?, ?, ?, ?, ?, ?)', brandId, category, sessions, prices[i], VALIDITY[sessions], sort++))
      }
      if (b.key === 'fitness') run("INSERT INTO packages (brand_id, category, sessions, price, validity, sort) VALUES (?, '私人小組訓練 Group PT', 16, 5600, '90 天', ?)", brandId, sort++)
      // Link numbers already connected with this brand's WhatsApp.
      run('UPDATE numbers SET brand_id = ? WHERE brand_id IS NULL AND phone = ?', brandId, `852${b.whatsapp.replace(/\D/g, '')}`)
    })
  })
}

export const brandById = (id: number | null | undefined) => (id ? get<Brand>('SELECT * FROM brands WHERE id = ?', id) : undefined)
export const brands = () => all<Brand>('SELECT * FROM brands ORDER BY sort, id')
export const branchesOf = (brandId?: number) =>
  brandId ? all<Branch>('SELECT * FROM branches WHERE brand_id = ? ORDER BY sort, id', brandId) : all<Branch>('SELECT * FROM branches ORDER BY brand_id, sort, id')
export const branchByKey = (key: string) => get<Branch>('SELECT * FROM branches WHERE key = ?', key)

/** The brand of the number a conversation came in on, or undefined if the number has none. */
export function brandOfConversation(conversationId: number) {
  const row = get<{ brand_id: number | null }>('SELECT n.brand_id FROM conversations c JOIN numbers n ON n.id = c.number_id WHERE c.id = ?', conversationId)
  return brandById(row?.brand_id)
}

export function trialOffersFor(brandId: number, branchKey: string) {
  return all<TrialOffer>('SELECT * FROM trial_offers WHERE brand_id = ? AND active = 1 ORDER BY sort, id', brandId)
    .filter((o) => o.branch_keys.split(',').map((k) => k.trim()).includes(branchKey))
}

export function packagesFor(brandId: number) {
  return all<Package>('SELECT * FROM packages WHERE brand_id = ? AND active = 1 ORDER BY sort, id', brandId)
}

export const packageLabel = (p: Package) => `${p.category} ${p.sessions} 堂`
export const money = (n: number) => `$${n.toLocaleString('en-US')}`

/** Find a branch named in a customer's message ("觀塘", "KT", "2"). */
export function matchBranch(text: string, options: Branch[]) {
  const t = text.trim().toLowerCase()
  const n = Number(t.match(/^\s*(\d)\s*$/)?.[1])
  if (n && options[n - 1]) return options[n - 1]
  return options.find((b) => [b.name, ...b.aliases.split(',')].map((a) => a.trim().toLowerCase()).some((a) => a && t.includes(a)))
}
