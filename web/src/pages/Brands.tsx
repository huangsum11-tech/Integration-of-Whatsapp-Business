import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { Icon } from '../components'

interface Branch { id: number; key: string; name: string; address: string }
interface Offer { id: number; branch_keys: string; label: string; price_text: string; validity: string; active: number }
interface Pkg { id: number; category: string; sessions: number; price: number; validity: string; backoffice_name: string; active: number }
export interface BrandFull {
  id: number; key: string; name: string; whatsapp: string
  booking_url: string; booking_platform: string; booking_steps: string; booking_steps_image: string | null
  fps_id: string; fps_name: string; payme_link: string; payment_qr_image: string | null; ref_prefix: string; after_trial_offer: string
  branches: Branch[]; trial_offers: Offer[]; packages: Pkg[]
}
interface Data {
  brands: BrandFull[]
  settings: { cross_brand_mode: 'refer' | 'answer'; trial_flow_enabled: boolean; purchase_flow_enabled: boolean; payment_screenshot_days: number }
}

/** Each brand's prices, booking link and payment details: never shared between brands. */
export default function Brands() {
  const { me } = useApp()
  const admin = me.role === 'admin'
  const [data, setData] = useState<Data | null>(null)
  const load = useCallback(() => { api<Data>('/brands').then(setData) }, [])
  useEffect(() => { load() }, [load])
  if (!data) return null
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>品牌及收款</h1>
          <p>每個品牌的試堂價、套票價、預約連結和 FPS／PayMe 收款資料各自獨立。對話只會讀取該號碼所屬品牌的資料。</p>
        </div>
      </div>
      <FlowSettings settings={data.settings} admin={admin} onSaved={load} />
      {data.brands.map((b) => <BrandCard key={b.id} brand={b} admin={admin} onSaved={load} />)}
    </div>
  )
}

function FlowSettings({ settings, admin, onSaved }: { settings: Data['settings']; admin: boolean; onSaved: () => void }) {
  const save = (patch: Partial<Data['settings']>) => api('/brands/settings', { method: 'PUT', body: patch }).then(onSaved)
  return (
    <section className="card ai-card" style={{ marginBottom: 20 }}>
      <div className="ai-card-head"><h2><Icon name="sparkle" size={18} />引導流程</h2></div>
      <fieldset className="form-stack" disabled={!admin}>
        <label className="toggle-row"><input type="checkbox" checked={settings.trial_flow_enabled} onChange={(e) => save({ trial_flow_enabled: e.target.checked })} />新生試堂引導：揀分店 → 揀課堂 → 試堂價 → 預約連結及步驟 → 提醒 → 跟進</label>
        <label className="toggle-row"><input type="checkbox" checked={settings.purchase_flow_enabled} onChange={(e) => save({ purchase_flow_enabled: e.target.checked })} />FPS／PayMe 購買：揀套票 → 報價 → 收款資料 → 收截圖 → 同事核實</label>
        <div className="col-pick">
          <div>
            <label className="label" htmlFor="cross">客人想去另一品牌的分店時</label>
            <select id="cross" className="select" value={settings.cross_brand_mode} onChange={(e) => save({ cross_brand_mode: e.target.value as 'refer' | 'answer' })}>
              <option value="refer">不報價，提供該品牌 WhatsApp 並轉交同事（建議）</option>
              <option value="answer">由這個號碼直接用該品牌資料回答</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="days">付款截圖保留（日，0 = 不自動刪除）</label>
            <input id="days" className="input num" type="number" min={0} defaultValue={settings.payment_screenshot_days}
              onBlur={(e) => Number(e.target.value) !== settings.payment_screenshot_days && save({ payment_screenshot_days: Number(e.target.value) })} />
          </div>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>退款、投訴、扣堂爭議、健康及個人餘額查詢，在任何一步出現都會即時中止流程並轉交同事。</p>
      </fieldset>
    </section>
  )
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function BrandCard({ brand, admin, onSaved }: { brand: BrandFull; admin: boolean; onSaved: () => void }) {
  const fields = ['whatsapp', 'booking_platform', 'booking_url', 'booking_steps', 'fps_id', 'fps_name', 'payme_link', 'ref_prefix', 'after_trial_offer'] as const
  const pick = (b: BrandFull) => Object.fromEntries(fields.map((f) => [f, b[f]])) as Record<(typeof fields)[number], string>
  const [form, setForm] = useState(pick(brand))
  const [msg, setMsg] = useState('')
  useEffect(() => setForm(pick(brand)), [brand])
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(brand))
  const save = async () => {
    setMsg('')
    try { await api(`/brands/${brand.id}`, { method: 'PUT', body: form }); setMsg('已儲存'); onSaved() }
    catch (err) { setMsg(err instanceof Error ? err.message : '未能儲存') }
  }
  const upload = async (kind: 'qr' | 'steps', file?: File) => {
    if (!file) return
    setMsg('')
    try { await api(`/brands/${brand.id}/image`, { body: { kind, dataUrl: await readFile(file) } }); onSaved() }
    catch (err) { setMsg(err instanceof Error ? err.message : '未能上載') }
  }
  const field = (key: (typeof fields)[number], label: string, hint?: string, area = false) => (
    <div>
      <label className="label" htmlFor={`${brand.key}-${key}`}>{label}</label>
      {area
        ? <textarea id={`${brand.key}-${key}`} className="textarea" rows={5} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        : <input id={`${brand.key}-${key}`} className="input" value={form[key]} placeholder={hint} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </div>
  )
  const missing = [!brand.booking_url && '預約連結', !brand.fps_id && !brand.payme_link && 'FPS／PayMe'].filter(Boolean)

  return (
    <section className="card ai-card brand-card">
      <div className="ai-card-head">
        <h2>{brand.name}</h2>
        <span className="muted" style={{ fontSize: 13 }}>{brand.branches.map((b) => b.name).join('、')}</span>
      </div>
      {missing.length > 0 && <div className="demo-hint" style={{ marginBottom: 12 }}>未設定：{missing.join('、')}。未設定前，相關步驟會轉交同事，AI 不會自行提供連結或收款資料。</div>}
      <fieldset className="form-stack" disabled={!admin}>
        <div className="brand-grid">
          <div className="form-stack">
            <h3 className="brand-sub">試堂預約</h3>
            {field('booking_platform', '預約 App 名稱（客人看到的名稱）', '例如 Fuse App')}
            {field('booking_url', '預約連結（深連結）', 'https://…')}
            {field('booking_steps', '預約步驟（傳給客人）', undefined, true)}
            <ImageField label="預約步驟圖片（可選）" path={brand.booking_steps_image} onPick={(f) => upload('steps', f)}
              onRemove={() => api(`/brands/${brand.id}/image/steps`, { method: 'DELETE' }).then(onSaved)} />
            {field('after_trial_offer', '試堂後跟進時附上的優惠（知識庫原文；留空則不提）', '例如：試堂後 24 小時內購買套票 95 折（FPS／PayMe）')}
          </div>
          <div className="form-stack">
            <h3 className="brand-sub">FPS／PayMe 收款</h3>
            {field('fps_id', 'FPS 識別碼／電話', '例如 FPS ID 或收款電話')}
            {field('fps_name', 'FPS 收款人名稱', '客人轉帳時會看到的名稱')}
            {field('payme_link', 'PayMe 連結', 'https://payme.hsbc/…')}
            <ImageField label="收款 QR 圖（WhatsApp 會連同付款資料一併傳送）" path={brand.payment_qr_image} onPick={(f) => upload('qr', f)}
              onRemove={() => api(`/brands/${brand.id}/image/qr`, { method: 'DELETE' }).then(onSaved)} />
            {field('ref_prefix', '參考編號字首（大楷英文）', 'FP')}
            {field('whatsapp', '品牌 WhatsApp（轉介時提供給客人）')}
          </div>
        </div>
        {admin && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
            <button type="button" className="btn primary sm" disabled={!dirty} onClick={save}>儲存 {brand.name}</button>
          </div>
        )}
      </fieldset>
      <OffersTable brand={brand} admin={admin} onSaved={onSaved} />
      <PackagesTable brand={brand} admin={admin} onSaved={onSaved} />
    </section>
  )
}

function ImageField({ label, path, onPick, onRemove }: { label: string; path: string | null; onPick: (f?: File) => void; onRemove: () => void }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="inline-form" style={{ marginTop: 0, alignItems: 'center' }}>
        {path ? <a href={`/media/${path}`} target="_blank" rel="noreferrer"><img src={`/media/${path}`} alt="" className="thumb" /></a> : <span className="faint" style={{ fontSize: 13 }}>未上載</span>}
        <label className="btn sm">{path ? '更換' : '上載圖片'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} /></label>
        {path && <button type="button" className="btn ghost sm" onClick={onRemove}>移除</button>}
      </div>
    </div>
  )
}

function OffersTable({ brand, admin, onSaved }: { brand: BrandFull; admin: boolean; onSaved: () => void }) {
  const update = (o: Offer, patch: Partial<Offer>) => {
    const next = { ...o, ...patch }
    return api(`/trial-offers/${o.id}`, { method: 'PUT', body: { branch_keys: next.branch_keys, label: next.label, price_text: next.price_text, validity: next.validity, active: Boolean(next.active) } }).then(onSaved)
  }
  return (
    <details className="catalogue" open>
      <summary>新學員試堂（每人一次）</summary>
      <div className="sample">
        <table className="table">
          <thead><tr><th>試堂</th><th>價錢</th><th>使用期</th><th>分店</th><th>啟用</th></tr></thead>
          <tbody>
            {brand.trial_offers.map((o) => (
              <tr key={o.id}>
                <td><input className="input cell" defaultValue={o.label} disabled={!admin} onBlur={(e) => e.target.value !== o.label && update(o, { label: e.target.value })} aria-label="試堂名稱" /></td>
                <td><input className="input cell num" defaultValue={o.price_text} disabled={!admin} onBlur={(e) => e.target.value !== o.price_text && update(o, { price_text: e.target.value })} aria-label="價錢" /></td>
                <td><input className="input cell" defaultValue={o.validity} disabled={!admin} onBlur={(e) => e.target.value !== o.validity && update(o, { validity: e.target.value })} aria-label="使用期" /></td>
                <td className="muted">{o.branch_keys.split(',').map((k) => brand.branches.find((b) => b.key === k.trim())?.name ?? k).join('、')}</td>
                <td><input type="checkbox" checked={Boolean(o.active)} disabled={!admin} onChange={(e) => update(o, { active: e.target.checked ? 1 : 0 })} aria-label="啟用" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function PackagesTable({ brand, admin, onSaved }: { brand: BrandFull; admin: boolean; onSaved: () => void }) {
  const update = (p: Pkg, patch: Partial<Pkg>) => {
    const n = { ...p, ...patch }
    return api(`/packages/${p.id}`, { method: 'PUT', body: { category: n.category, sessions: n.sessions, price: n.price, validity: n.validity, backoffice_name: n.backoffice_name, active: Boolean(n.active) } }).then(onSaved)
  }
  return (
    <details className="catalogue">
      <summary>套票價目（{brand.packages.length} 項，原價；折實價不會自動計算）</summary>
      <div className="sample" style={{ maxHeight: 420 }}>
        <table className="table">
          <thead><tr><th>類別</th><th>堂數</th><th>價錢</th><th>有效期</th><th>後台套票名稱</th><th>啟用</th></tr></thead>
          <tbody>
            {brand.packages.map((p) => (
              <tr key={p.id}>
                <td>{p.category}</td>
                <td className="num">{p.sessions}</td>
                <td><input className="input cell num" type="number" defaultValue={p.price} disabled={!admin} onBlur={(e) => Number(e.target.value) !== p.price && update(p, { price: Number(e.target.value) })} aria-label="價錢" /></td>
                <td><input className="input cell" defaultValue={p.validity} disabled={!admin} onBlur={(e) => e.target.value !== p.validity && update(p, { validity: e.target.value })} aria-label="有效期" /></td>
                <td><input className="input cell" defaultValue={p.backoffice_name} placeholder="自動入帳用" disabled={!admin} onBlur={(e) => e.target.value !== p.backoffice_name && update(p, { backoffice_name: e.target.value })} aria-label="後台套票名稱" /></td>
                <td><input type="checkbox" checked={Boolean(p.active)} disabled={!admin} onChange={(e) => update(p, { active: e.target.checked ? 1 : 0 })} aria-label="啟用" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
