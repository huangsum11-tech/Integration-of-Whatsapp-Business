import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { Icon } from '../components'
import { formatPhone } from '../format'
import { getSocket } from '../socket'

interface Settings {
  number_id: number | null; template: string; wa_template_name: string; wa_template_language: string
  wa_template_params: string; reminder_phone: string; reminder_hour: number
}
interface Instructor { id: number; name: string; phone: string; active: number }
interface RunSummary {
  id: number; month: string; status: 'draft' | 'scheduled' | 'sending' | 'sent'; scheduled_at: number | null
  created_at: number; sent_at: number | null; created_by_name: string | null; total: number; sent: number; failed: number
}
interface Item {
  id: number; instructor_name: string; message: string; status: 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null; sent_at: number | null; phone: string | null; active: number | null
}
type Run = RunSummary & { items: Item[] }
interface Overview { settings: Settings; defaultTemplate: string; instructors: Instructor[]; runs: RunSummary[] }

const RUN_STATUS: Record<RunSummary['status'], [string, string]> = {
  draft: ['', '未發送'], scheduled: ['iris', '已排程'], sending: ['coral', '發送中'], sent: ['pine', '已發送'],
}
const ITEM_STATUS: Record<Item['status'], [string, string]> = {
  pending: ['', '待發送'], sent: ['pine', '已發送'], failed: ['coral', '失敗'], skipped: ['', '略過'],
}

const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return `${y}年${Number(mo)}月` }
const dateTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function Payroll() {
  const [data, setData] = useState<Overview | null>(null)
  const [runId, setRunId] = useState<number | null>(null)
  const load = useCallback(() => { api<Overview>('/payroll').then(setData) }, [])
  useEffect(() => { load() }, [load])

  if (!data) return null
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>導師糧單</h1>
          <p>從 Vibefam 匯出每月糧單報表（CSV），上載後預覽，再經 WhatsApp 逐一發給導師。</p>
        </div>
      </div>
      <div className="ai-grid">
        <div className="ai-col">
          {runId
            ? <RunView runId={runId} settings={data.settings} onBack={() => { setRunId(null); load() }} onChanged={load} />
            : <NewRun onCreated={(id) => { setRunId(id); load() }} />}
          <History runs={data.runs} onOpen={setRunId} />
        </div>
        <div className="ai-col">
          <SettingsCard data={data} onSaved={load} />
          <Instructors instructors={data.instructors} onChanged={load} />
          <NotifyInstructors instructors={data.instructors} />
        </div>
      </div>
    </div>
  )
}

function NewRun({ onCreated }: { onCreated: (id: number) => void }) {
  const [month, setMonth] = useState(thisMonth())
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [info, setInfo] = useState<{ columns: string[]; rowCount: number; sample: string[][] } | null>(null)
  const [cols, setCols] = useState({ name: '', amount: '', count: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(''); setInfo(null)
    const text = await file.text()
    setCsv(text); setFileName(file.name)
    try {
      const r = await api<{ columns: string[]; rowCount: number; sample: string[][]; guess: { name?: string; amount?: string; count?: string } }>('/payroll/analyze', { body: { csv: text } })
      setInfo(r)
      setCols({ name: r.guess.name ?? '', amount: r.guess.amount ?? '', count: r.guess.count ?? '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '未能讀取報表')
    }
  }

  const create = async () => {
    setBusy(true); setError('')
    try {
      const run = await api<Run>('/payroll/runs', { body: { month, csv, nameColumn: cols.name, amountColumn: cols.amount || undefined, countColumn: cols.count || undefined } })
      onCreated(run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未能建立糧單')
    } finally {
      setBusy(false)
    }
  }

  const select = (key: keyof typeof cols, label: string, optional: string) => (
    <div>
      <label className="label">{label}</label>
      <select className="select" value={cols[key]} onChange={(e) => setCols({ ...cols, [key]: e.target.value })}>
        <option value="">{optional}</option>
        {info!.columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  )

  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="wallet" size={18} />新一期糧單</h2></div>
      <ol className="steps" style={{ marginTop: 0 }}>
        <li>在 Vibefam 匯出該月的導師糧單／Payroll 報表，儲存為 <b>CSV</b>（Excel 檔可以「另存新檔 → CSV UTF-8」）</li>
        <li>選擇月份及上載檔案，確認哪一欄是導師名稱和金額</li>
        <li>預覽每位導師的訊息，然後發送或排程</li>
      </ol>
      <div className="form-stack">
        <div className="inline-form" style={{ marginTop: 0 }}>
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="月份" style={{ maxWidth: 180 }} />
          <label className="btn sm">
            <Icon name="file" size={14} />{fileName || '選擇 CSV 檔案'}
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
        {info && (
          <>
            <div className="faint" style={{ fontSize: 12 }}>讀到 {info.rowCount} 行資料，{info.columns.length} 欄。</div>
            <div className="col-pick">
              {select('name', '導師名稱欄（必填）', '請選擇')}
              {select('amount', '金額欄（加總）', '不用')}
              {select('count', '堂數欄（加總）', '不用：按行數計算')}
            </div>
            <div className="sample">
              <table className="table">
                <thead><tr>{info.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{info.sample.map((r, i) => <tr key={i}>{info.columns.map((_, j) => <td key={j}>{r[j]}</td>)}</tr>)}</tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary sm" disabled={!cols.name || !month || busy} onClick={create}>{busy ? '處理中…' : '產生預覽'}</button>
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  )
}

function RunView({ runId, settings, onBack, onChanged }: { runId: number; settings: Settings; onBack: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [when, setWhen] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(() => { api<Run>(`/payroll/runs/${runId}`).then(setRun) }, [runId])
  useEffect(() => {
    load()
    const socket = getSocket()
    const onPayroll = (e: { runId: number }) => { if (e.runId === runId) { load(); onChanged() } }
    socket.on('payroll', onPayroll)
    return () => { socket.off('payroll', onPayroll) }
  }, [load, runId, onChanged])

  if (!run) return null
  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn(); load(); onChanged() } catch (err) { setError(err instanceof Error ? err.message : '操作失敗') }
  }
  const toSend = run.items.filter((i) => i.status === 'pending' || i.status === 'failed')
  const noPhone = toSend.filter((i) => !i.phone)
  const sendNow = () => act(async () => {
    if (!confirm(`即時發送 ${toSend.length} 份糧單？${noPhone.length ? `\n（${noPhone.length} 位未有電話，會標示失敗）` : ''}`)) return
    await api(`/payroll/runs/${run.id}/send`, { body: {} })
  })
  const schedule = () => act(() => api(`/payroll/runs/${run.id}/send`, { body: { at: Math.floor(new Date(when).getTime() / 1000) } }))
  const [tone, label] = RUN_STATUS[run.status]

  return (
    <section className="card ai-card">
      <div className="ai-card-head">
        <h2>
          <button className="btn ghost sm" onClick={onBack} aria-label="返回"><Icon name="back" size={16} /></button>
          {monthLabel(run.month)}糧單
        </h2>
        <span className={`chip ${tone}`}>{label}{run.status === 'scheduled' && run.scheduled_at ? `：${dateTime(run.scheduled_at)}` : ''}</span>
      </div>

      {!settings.number_id && <div className="error" style={{ marginBottom: 8 }}>請先在右邊「發送設定」選擇用哪個 WhatsApp 號碼發送。</div>}
      {noPhone.length > 0 && <div className="demo-hint" style={{ marginBottom: 8 }}>{noPhone.length} 位導師未有 WhatsApp 號碼，請在下面直接填寫。</div>}

      {run.status !== 'sent' && run.status !== 'sending' && toSend.length > 0 && (
        <div className="run-actions">
          <button className="btn primary sm" onClick={sendNow}><Icon name="send" size={14} />即時發送（{toSend.length}）</button>
          {run.status === 'scheduled'
            ? <button className="btn sm" onClick={() => act(() => api(`/payroll/runs/${run.id}/send`, { body: { at: null } }))}>取消排程</button>
            : <>
                <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="排程時間" style={{ maxWidth: 220 }} />
                <button className="btn sm" disabled={!when} onClick={schedule}><Icon name="clock" size={14} />排程發送</button>
              </>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" title="修改範本後，用最新範本重新產生未發送的訊息" onClick={() => act(() => api(`/payroll/runs/${run.id}/rerender`, { body: {} }))}>用最新範本重新產生</button>
          {run.sent === 0 && <button className="btn ghost sm danger" onClick={() => act(async () => { if (confirm('刪除這期糧單？')) { await api(`/payroll/runs/${run.id}`, { method: 'DELETE' }); onBack() } })}>刪除</button>}
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}

      <div className="payslips">
        {run.items.map((item) => <PayslipItem key={item.id} item={item} locked={run.status === 'sending'} onChanged={load} />)}
      </div>
    </section>
  )
}

function PayslipItem({ item, locked, onChanged }: { item: Item; locked: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState(item.message)
  const [phone, setPhone] = useState('')
  useEffect(() => setMessage(item.message), [item.message])
  const [tone, label] = ITEM_STATUS[item.status]
  const editable = !locked && item.status !== 'sent'

  const savePhone = async () => {
    const list = await api<{ instructors: Instructor[] }>('/payroll')
    const who = list.instructors.find((i) => i.name === item.instructor_name)
    if (who) await api(`/payroll/instructors/${who.id}`, { method: 'PATCH', body: { phone } })
    else await api('/payroll/instructors', { body: { name: item.instructor_name, phone } })
    setPhone(''); onChanged()
  }

  return (
    <div className={`payslip ${item.status === 'skipped' ? 'off' : ''}`}>
      <div className="payslip-head">
        <b>{item.instructor_name}</b>
        {item.phone ? <span className="muted num" style={{ fontSize: 13 }}>{formatPhone(item.phone)}</span> : (
          <span className="inline-form" style={{ margin: 0 }}>
            <input className="input" style={{ padding: '3px 8px', width: 140 }} placeholder="WhatsApp 號碼" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn sm" disabled={phone.replace(/\D/g, '').length < 8} onClick={savePhone}>儲存</button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className={`chip ${tone}`}>{label}{item.sent_at ? ` ${dateTime(item.sent_at)}` : ''}</span>
      </div>
      {item.error && item.status === 'failed' && <div className="error">{item.error}</div>}
      {editing ? (
        <>
          <textarea className="textarea" rows={8} value={message} onChange={(e) => setMessage(e.target.value)} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn ghost sm" onClick={() => { setMessage(item.message); setEditing(false) }}>取消</button>
            <button className="btn primary sm" onClick={async () => { await api(`/payroll/items/${item.id}`, { method: 'PATCH', body: { message } }); setEditing(false); onChanged() }}>儲存</button>
          </div>
        </>
      ) : <div className="payslip-message">{item.message}</div>}
      {editable && !editing && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={() => api(`/payroll/items/${item.id}`, { method: 'PATCH', body: { skip: item.status !== 'skipped' } }).then(onChanged)}>
            {item.status === 'skipped' ? '恢復' : '略過'}
          </button>
          {item.status !== 'skipped' && <button className="btn ghost sm" onClick={() => setEditing(true)}>修改訊息</button>}
        </div>
      )}
    </div>
  )
}

function History({ runs, onOpen }: { runs: RunSummary[]; onOpen: (id: number) => void }) {
  if (runs.length === 0) return null
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="archive" size={18} />過往紀錄</h2></div>
      <div className="kb-list">
        {runs.map((r) => {
          const [tone, label] = RUN_STATUS[r.status]
          return (
            <button key={r.id} className="kb-item" onClick={() => onOpen(r.id)}>
              <div className="kb-top">
                <b>{monthLabel(r.month)}</b>
                <span className={`chip ${tone}`}>{label}</span>
                <span className="faint" style={{ fontSize: 12, marginLeft: 'auto' }}>已發 {r.sent}／{r.total}{r.failed ? `，失敗 ${r.failed}` : ''}</span>
              </div>
              <div className="faint" style={{ fontSize: 12 }}>{r.created_by_name ?? ''} 建立於 {dateTime(r.created_at)}</div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function SettingsCard({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const { numbers } = useApp()
  const [form, setForm] = useState(data.settings)
  const [saved, setSaved] = useState(false)
  useEffect(() => setForm(data.settings), [data.settings])
  const senders = numbers.filter((n) => n.channel.startsWith('wa_'))
  const sender = numbers.find((n) => n.id === form.number_id)
  const save = async () => {
    await api('/payroll/settings', { method: 'PUT', body: form })
    setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2000)
  }
  const placeholders = ['導師', '月份', '堂數', '金額', '明細']

  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="send" size={18} />發送設定</h2></div>
      <div className="form-stack">
        <div>
          <label className="label" htmlFor="pay-number">用哪個 WhatsApp 號碼發送</label>
          <select id="pay-number" className="select" value={form.number_id ?? ''} onChange={(e) => setForm({ ...form, number_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">請選擇</option>
            {senders.map((n) => <option key={n.id} value={n.id}>{n.label}{n.demo ? '（示範，不會真正發出）' : ''}</option>)}
          </select>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>糧單對話只有管理員在收件匣看到。</div>
        </div>
        <div>
          <label className="label" htmlFor="pay-template">訊息範本</label>
          <textarea id="pay-template" className="textarea" rows={9} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} />
          <div className="kb-tools" style={{ margin: '4px 0 0' }}>
            可用：{placeholders.map((p) => <code key={p}>{`{${p}}`}</code>)} 及報表任何欄名，例如 <code>{'{Class}'}</code>
            <button className="btn ghost sm" onClick={() => setForm({ ...form, template: data.defaultTemplate })}>還原預設</button>
          </div>
        </div>
        {sender?.channel === 'wa_cloud' && (
          <div className="demo-hint">
            官方 Cloud API 主動發訊息必須用 Meta 已審批的<b>模板</b>（類別選「Utility」）。在 Meta 建立模板，內文用 {'{{1}}'}、{'{{2}}'}… 作變數，然後填寫：
            <div className="col-pick" style={{ marginTop: 8 }}>
              <div><label className="label">模板名稱</label><input className="input" value={form.wa_template_name} placeholder="例如 monthly_payslip" onChange={(e) => setForm({ ...form, wa_template_name: e.target.value.trim() })} /></div>
              <div><label className="label">語言代碼</label><input className="input" value={form.wa_template_language} onChange={(e) => setForm({ ...form, wa_template_language: e.target.value.trim() })} /></div>
            </div>
            <label className="label" style={{ marginTop: 8 }}>變數 {'{{1}}'}、{'{{2}}'}… 依次對應（逗號分隔）</label>
            <input className="input" value={form.wa_template_params} onChange={(e) => setForm({ ...form, wa_template_params: e.target.value })} />
          </div>
        )}
        <div>
          <label className="label">月底提醒（每月最後一日，WhatsApp 提醒你從 Vibefam 匯出報表）</label>
          <div className="inline-form" style={{ marginTop: 0 }}>
            <input className="input" inputMode="tel" placeholder="你的 WhatsApp 號碼（留空則不提醒）" value={form.reminder_phone} onChange={(e) => setForm({ ...form, reminder_phone: e.target.value })} />
            <select className="select" style={{ width: 110 }} value={form.reminder_hour} onChange={(e) => setForm({ ...form, reminder_hour: Number(e.target.value) })} aria-label="提醒時間">
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          {saved && <span className="muted" style={{ fontSize: 13 }}>已儲存</span>}
          <button className="btn primary sm" onClick={save}>儲存</button>
        </div>
      </div>
    </section>
  )
}

function Instructors({ instructors, onChanged }: { instructors: Instructor[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '' })
  const [error, setError] = useState('')
  const add = async () => {
    setError('')
    try { await api('/payroll/instructors', { body: form }); setForm({ name: '', phone: '' }); onChanged() }
    catch (err) { setError(err instanceof Error ? err.message : '未能新增') }
  }
  const update = (i: Instructor, patch: Partial<{ phone: string; active: boolean }>) =>
    api(`/payroll/instructors/${i.id}`, { method: 'PATCH', body: patch }).then(onChanged)

  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="team" size={18} />導師名單</h2></div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>名稱要和 Vibefam 報表上的導師名稱一樣。上載報表時，新名稱會自動加入。</p>
      <div className="instructor-list">
        {instructors.map((i) => (
          <div key={i.id} className={`instructor ${i.active ? '' : 'off'}`}>
            <span className="name">{i.name}</span>
            <input className="input" inputMode="tel" defaultValue={i.phone ? formatPhone(i.phone) : ''} placeholder="WhatsApp 號碼"
              onBlur={(e) => e.target.value.replace(/\D/g, '') !== i.phone && update(i, { phone: e.target.value })} aria-label={`${i.name} 的電話`} />
            <button className="btn ghost sm" onClick={() => update(i, { active: !i.active })}>{i.active ? '停用' : '啟用'}</button>
          </div>
        ))}
      </div>
      <div className="inline-form">
        <input className="input" placeholder="導師名稱" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input" placeholder="WhatsApp 號碼" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <button className="btn sm" disabled={!form.name.trim()} onClick={add} aria-label="新增導師"><Icon name="plus" size={15} /></button>
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    </section>
  )
}

function NotifyInstructors({ instructors }: { instructors: Instructor[] }) {
  const active = instructors.filter((i) => i.active)
  const [ids, setIds] = useState<number[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<{ name: string; ok: boolean; error?: string }[] | null>(null)
  const [error, setError] = useState('')
  const toggle = (id: number) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  const send = async () => {
    if (!confirm(`發送給 ${ids.length} 位導師？`)) return
    setBusy(true); setError(''); setResults(null)
    try { setResults((await api<{ results: { name: string; ok: boolean; error?: string }[] }>('/payroll/notify', { body: { message, ids } })).results) }
    catch (err) { setError(err instanceof Error ? err.message : '發送失敗') }
    finally { setBusy(false) }
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="megaphone" size={18} />通知導師</h2></div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>代課、請假、時間表更改等，一次發給選中的導師。{'{導師}'} 會換成導師名稱。</p>
      <div className="tag-list" style={{ marginBottom: 8 }}>
        <button type="button" className={`chip ${ids.length === active.length && active.length ? 'pine' : ''}`} style={{ border: 0, cursor: 'pointer' }}
          onClick={() => setIds(ids.length === active.length ? [] : active.map((i) => i.id))}>全部</button>
        {active.map((i) => (
          <button key={i.id} type="button" className={`chip ${ids.includes(i.id) ? 'pine' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => toggle(i.id)}>
            {ids.includes(i.id) && <Icon name="check" size={11} />}{i.name}{i.phone ? '' : '（無電話）'}
          </button>
        ))}
      </div>
      <textarea className="textarea" rows={4} value={message} placeholder={'例如：{導師} 你好，12/12（六）10:00 Reformer 需要代課，有冇時間？'} onChange={(e) => setMessage(e.target.value)} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn primary sm" disabled={busy || !ids.length || !message.trim()} onClick={send}>{busy ? '發送中…' : `發送（${ids.length}）`}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {results && <div className="faint" style={{ fontSize: 13, marginTop: 6 }}>{results.map((r) => `${r.name}：${r.ok ? '已發送' : `失敗（${r.error}）`}`).join('；')}</div>}
    </section>
  )
}
