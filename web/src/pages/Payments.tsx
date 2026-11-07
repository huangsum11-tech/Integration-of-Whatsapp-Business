import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../components'
import { formatPhone } from '../format'
import { getSocket } from '../socket'

interface Request {
  id: number; ref: string; conversation_id: number; brand_name: string; contact_name: string; phone: string | null
  package_label: string; listed_price: number | null; amount: number | null; status: string; discount_note: string
  screenshot: string | null; screenshot_at: number | null; return_reason: string | null
  verified_by_name: string | null; verified_at: number | null; credited_by_name: string | null; created_at: number; updated_at: number
}
interface Queue { requests: Request[]; counts: { verify: number; quote: number; credit: number }; labels: Record<string, string> }
interface Summary { today: { brand: string; count: number; total: number }[]; week: { brand: string; count: number; total: number }[] }

const TABS = [
  { id: 'awaiting_verification', label: '待核實', count: 'verify' },
  { id: 'pending_quote', label: '待報價', count: 'quote' },
  { id: 'verified', label: '待入帳', count: 'credit' },
  { id: 'open', label: '全部進行中' },
  { id: '', label: '全部紀錄' },
] as const

const REASONS: Record<string, string> = { amount_mismatch: '金額不符', unclear: '截圖不清', not_found: '找不到入帳' }
const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString('en-US')}`)
const when = (ts: number) => new Date(ts * 1000).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/** Teammates check FPS / PayMe screenshots against the bank record, one by one. */
export default function Payments() {
  const [tab, setTab] = useState<string>('awaiting_verification')
  const [q, setQ] = useState('')
  const [queue, setQueue] = useState<Queue | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const load = useCallback(() => {
    const params = new URLSearchParams({ status: tab })
    if (q) params.set('q', q)
    api<Queue>(`/payments?${params}`).then(setQueue)
    api<Summary>('/payments/summary').then(setSummary)
  }, [tab, q])
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    const socket = getSocket()
    socket.on('payment', load)
    return () => { clearTimeout(t); socket.off('payment', load) }
  }, [load, q])
  if (!queue) return null

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>付款核實</h1>
          <p>對照銀行／FPS／PayMe 入帳紀錄逐筆核實。核實並在後台加入套票後，客人才會收到「已生效」通知。</p>
        </div>
        {summary && (
          <div className="pay-summary" aria-label="已核實摘要（內部）">
            {summary.today.length === 0 && summary.week.length === 0 ? <span className="faint">本週未有已核實付款</span> : (
              <>
                <span>今日 {summary.today.reduce((s, r) => s + r.count, 0)} 筆 {money(summary.today.reduce((s, r) => s + r.total, 0))}</span>
                <span>本週 {summary.week.map((r) => `${r.brand} ${r.count} 筆 ${money(r.total)}`).join('，') || '—'}</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="pay-tools">
        <div className="tabs" role="tablist" aria-label="付款狀態">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}{'count' in t && queue.counts[t.count] ? <span className="count">{queue.counts[t.count]}</span> : null}
            </button>
          ))}
        </div>
        <div className="search" style={{ maxWidth: 280, flex: 1 }}>
          <Icon name="search" size={16} />
          <input className="input" placeholder="搜尋參考編號、客人、電話" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋付款" />
        </div>
      </div>
      {queue.requests.length === 0 ? (
        <div className="needs-empty" style={{ marginTop: 12 }}><Icon name="check" size={22} /><span>這裏沒有要處理的付款。</span></div>
      ) : (
        <div className="pay-list">
          {queue.requests.map((r) => <PaymentCard key={r.id} r={r} label={queue.labels[r.status] ?? r.status} onChanged={load} />)}
        </div>
      )}
    </div>
  )
}

function PaymentCard({ r, label, onChanged }: { r: Request; label: string; onChanged: () => void }) {
  const [reason, setReason] = useState('amount_mismatch')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (path: string, body: object = {}, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return
    setBusy(true); setError('')
    try { await api(`/payments/${r.id}/${path}`, { body }); onChanged() }
    catch (err) { setError(err instanceof Error ? err.message : '操作失敗') }
    finally { setBusy(false) }
  }
  const tone = r.status === 'awaiting_verification' || r.status === 'pending_quote' ? 'coral' : r.status === 'verified' ? 'iris' : r.status === 'notified' ? 'pine' : ''

  return (
    <article className="pay-card">
      <div className="pay-shot">
        {r.screenshot
          ? <a href={`/media/${r.screenshot}`} target="_blank" rel="noreferrer" title="開啟原圖"><img src={`/media/${r.screenshot}`} alt={`${r.ref} 付款截圖`} /></a>
          : <span className="faint">{r.screenshot_at ? '截圖已過保留期刪除' : '未收到截圖'}</span>}
      </div>
      <div className="pay-body">
        <div className="pay-head">
          <b className="num">{r.ref}</b>
          <span className={`chip ${tone}`}>{label}</span>
          <span className="muted">{r.brand_name}</span>
          <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>更新 {when(r.updated_at)}</span>
        </div>
        <dl className="kv pay-kv">
          <dt>客人</dt><dd><a href={`#/inbox/${r.conversation_id}`}>{r.contact_name}</a> <span className="muted num">{formatPhone(r.phone)}</span></dd>
          <dt>套票</dt><dd>{r.package_label}</dd>
          <dt>應付</dt><dd><b>{money(r.amount)}</b>{r.listed_price != null && r.amount !== r.listed_price && <span className="muted">（原價 {money(r.listed_price)}）</span>}</dd>
          {r.discount_note && <><dt>優惠</dt><dd>{r.discount_note}</dd></>}
          <dt>備註要求</dt><dd className="muted">電話 + {r.ref}</dd>
          {r.verified_by_name && <><dt>核實</dt><dd>{r.verified_by_name}{r.verified_at ? `，${when(r.verified_at)}` : ''}</dd></>}
        </dl>
        <div className="pay-actions">
          {r.status === 'pending_quote' && (
            <>
              <input className="input cell num" inputMode="numeric" placeholder="應付金額" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} aria-label="應付金額" style={{ width: 120 }} />
              <button className="btn primary sm" disabled={busy || !amount} onClick={() => act('quote', { amount: Number(amount) }, `向客人報價 $${Number(amount).toLocaleString('en-US')} 並發送收款資料？`)}>發出報價及收款資料</button>
            </>
          )}
          {r.status === 'awaiting_verification' && (
            <>
              <button className="btn primary sm" disabled={busy} onClick={() => act('verify', {}, `確認已在銀行／FPS／PayMe 看到 ${money(r.amount)}（備註 ${r.ref}）？`)}><Icon name="check" size={14} />核實通過</button>
              <select className="select cell" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="退回原因">
                {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="btn sm" disabled={busy} onClick={() => act('return', { reason }, `以「${REASONS[reason]}」退回並通知客人？`)}>退回</button>
            </>
          )}
          {r.status === 'verified' && (
            <>
              <span className="muted" style={{ fontSize: 13 }}>請在後台為客人加入「{r.package_label}」，完成後按：</span>
              <button className="btn primary sm" disabled={busy} onClick={() => act('credit', {}, '確認已在後台加入套票？系統會通知客人「已生效」。')}>已入帳，通知客人</button>
              <AssistButton requestId={r.id} />
            </>
          )}
          {!['notified', 'cancelled', 'credited'].includes(r.status) && (
            <button className="btn ghost sm danger" disabled={busy} onClick={() => act('cancel', {}, `取消 ${r.ref}？`)}>取消</button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </article>
  )
}

/** Stage-2 back-office assist (part C). Shown only when it is configured on the server. */
function AssistButton({ requestId }: { requestId: number }) {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { api<{ enabled: boolean }>('/backoffice/status').then(setStatus).catch(() => setStatus(null)) }, [])
  if (!status?.enabled) return null
  const run = async () => {
    setMsg('執行中…')
    try {
      const r = await api<{ status: string; detail: string }>(`/backoffice/add-package/${requestId}`, { body: {} })
      setMsg(r.status === 'awaiting_confirmation' ? '已填好表格，請在自動開啟的瀏覽器核對後按確認，然後回來按「已入帳」。' : `已停止：${r.detail}`)
    } catch (err) { setMsg(err instanceof Error ? err.message : '執行失敗') }
  }
  return (
    <>
      <button className="btn sm" onClick={run}><Icon name="send" size={14} />後台輔助填表</button>
      {msg && <span className="muted" style={{ fontSize: 12, flexBasis: '100%' }}>{msg}</span>}
    </>
  )
}
