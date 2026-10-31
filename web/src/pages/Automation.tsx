import { useCallback, useEffect, useState } from 'react'
import { api, type QuickReply, type Trial } from '../api'
import { useApp } from '../App'
import { Icon, Modal } from '../components'
import { formatPhone } from '../format'
import { getSocket } from '../socket'

interface Settings {
  notify_number_id: number | null
  followup_enabled: boolean; followup_minutes: number; followup_message: string
  followup_wa_template_name: string; followup_wa_template_language: string
  alert_enabled: boolean; alert_minutes: number; alert_phone: string; alert_from_hour: number; alert_to_hour: number
}
interface Report { report_enabled: boolean; report_phones: string; report_weekday: number; report_hour: number }
interface Overview {
  settings: Settings; defaultFollowup: string; trials: (Trial & { contact_name: string })[]
  team: { id: number; name: string; phone: string }[]
  report: Report; review: { url: string; message: string }; transcription: boolean
}

const FOLLOWUP: Record<Trial['followup_status'], [string, string]> = {
  pending: ['', '待跟進'], sent: ['pine', '已跟進'], failed: ['coral', '失敗'], skipped: ['', '不跟進'],
}
const hours = Array.from({ length: 25 }, (_, h) => h)
const when = (ts: number) => new Date(ts * 1000).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export default function Automation() {
  const { me } = useApp()
  const isAdmin = me.role === 'admin'
  const [data, setData] = useState<Overview | null>(null)
  const load = useCallback(() => { api<Overview>('/automation').then(setData) }, [])
  useEffect(() => {
    load()
    const socket = getSocket()
    socket.on('trial', load)
    return () => { socket.off('trial', load) }
  }, [load])
  if (!data) return null

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>自動化</h1>
          <p>試堂跟進、客人等待提醒及快速回覆。</p>
        </div>
      </div>
      <div className="ai-grid">
        <div className="ai-col">
          <TrialsCard trials={data.trials} />
          <QuickRepliesCard isAdmin={isAdmin} />
          <ReviewCard review={data.review} isAdmin={isAdmin} onSaved={load} />
        </div>
        <div className="ai-col">
          <SettingsCard data={data} isAdmin={isAdmin} onSaved={load} />
          <ReportCard report={data.report} isAdmin={isAdmin} onSaved={load} />
          <section className="card ai-card">
            <div className="ai-card-head"><h2><Icon name="note" size={18} />語音轉文字</h2></div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {data.transcription
                ? '已啟用：客人的語音訊息會自動轉成文字，顯示在語音下面，AI 也會根據內容回覆。'
                : '未啟用：在伺服器 .env 填寫 GEMINI_API_KEY 後重新啟動即可（不論你用哪個 AI 回覆客人，轉文字都用 Gemini）。'}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

function TrialsCard({ trials }: { trials: Overview['trials'] }) {
  const now = Date.now() / 1000
  const upcoming = trials.filter((t) => t.class_at >= now && t.status === 'booked').reverse()
  const recent = trials.filter((t) => t.class_at < now || t.status !== 'booked')
  const row = (t: Overview['trials'][number]) => {
    const [tone, label] = FOLLOWUP[t.followup_status]
    return (
      <a key={t.id} className="kb-item" href={t.conversation_id ? `#/inbox/${t.conversation_id}` : undefined} style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="kb-top">
          <b>{t.contact_name}</b>
          <span className="muted" style={{ fontSize: 13 }}>{when(t.class_at)} {t.class_name}</span>
          <span style={{ marginLeft: 'auto' }} className={`chip ${t.status === 'cancelled' ? '' : tone}`}>{t.status === 'cancelled' ? '已取消' : label}</span>
        </div>
        {t.followup_status === 'failed' && t.followup_error && <div className="error" style={{ fontSize: 12 }}>{t.followup_error}</div>}
      </a>
    )
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="clock" size={18} />試堂名單</h2></div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
        客人在 WhatsApp／IG 告訴 AI 已預約的試堂時間，會自動記錄；同事也可以在對話右邊「試堂」加入。上堂後按設定時間自動跟進。
      </p>
      <div className="label">即將上堂（{upcoming.length}）</div>
      <div className="kb-list" style={{ marginBottom: 12 }}>
        {upcoming.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>暫時沒有</div> : upcoming.map(row)}
      </div>
      <div className="label">最近兩星期</div>
      <div className="kb-list">
        {recent.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>暫時沒有</div> : recent.map(row)}
      </div>
    </section>
  )
}

function SettingsCard({ data, isAdmin, onSaved }: { data: Overview; isAdmin: boolean; onSaved: () => void }) {
  const { numbers } = useApp()
  const [form, setForm] = useState(data.settings)
  const [saved, setSaved] = useState(false)
  useEffect(() => setForm(data.settings), [data.settings])
  const sender = numbers.find((n) => n.id === form.notify_number_id)
  const save = async () => {
    await api('/automation/settings', { method: 'PUT', body: form })
    setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2000)
  }
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value })

  return (
    <>
      <section className="card ai-card">
        <div className="ai-card-head"><h2><Icon name="sparkle" size={18} />試堂跟進</h2></div>
        <fieldset className="form-stack" disabled={!isAdmin}>
          <label className="toggle-row">
            <input type="checkbox" checked={form.followup_enabled} onChange={(e) => set('followup_enabled', e.target.checked)} />
            上完試堂後自動發跟進訊息
          </label>
          <div>
            <label className="label" htmlFor="fu-min">試堂開始後幾耐發送</label>
            <select id="fu-min" className="select" value={form.followup_minutes} onChange={(e) => set('followup_minutes', Number(e.target.value))}>
              {[60, 90, 120, 150, 180].map((m) => <option key={m} value={m}>{m / 60} 小時（即 1 小時課堂後約 {m / 60 - 1} 小時）</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fu-msg">跟進訊息（{'{名稱}'} = 客人名稱，{'{課堂}'} = 課堂名稱）</label>
            <textarea id="fu-msg" className="textarea" rows={4} value={form.followup_message} onChange={(e) => set('followup_message', e.target.value)} />
            <button className="btn ghost sm" type="button" onClick={() => set('followup_message', data.defaultFollowup)}>還原預設</button>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            客人回覆後，AI 會按知識庫介紹套票；想報名的會轉交同事。官方 Cloud API 號碼如果距離客人上次傳訊息超過 24 小時，要用已審批的模板（變數 {'{{1}}'} = 客人名稱）：
          </div>
          <div className="col-pick">
            <div><label className="label">Cloud API 模板名稱（可選）</label><input className="input" value={form.followup_wa_template_name} onChange={(e) => set('followup_wa_template_name', e.target.value.trim())} /></div>
            <div><label className="label">語言代碼</label><input className="input" value={form.followup_wa_template_language} onChange={(e) => set('followup_wa_template_language', e.target.value.trim())} /></div>
          </div>
        </fieldset>
      </section>

      <section className="card ai-card">
        <div className="ai-card-head"><h2><Icon name="handoff" size={18} />客人等待提醒</h2></div>
        <fieldset className="form-stack" disabled={!isAdmin}>
          <label className="toggle-row">
            <input type="checkbox" checked={form.alert_enabled} onChange={(e) => set('alert_enabled', e.target.checked)} />
            客人等同事回覆太耐，用 WhatsApp 提醒
          </label>
          <div className="col-pick">
            <div>
              <label className="label">等待超過</label>
              <select className="select" value={form.alert_minutes} onChange={(e) => set('alert_minutes', Number(e.target.value))}>
                {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} 分鐘</option>)}
              </select>
            </div>
            <div>
              <label className="label">只在這段時間提醒</label>
              <div className="inline-form" style={{ marginTop: 0 }}>
                <select className="select" value={form.alert_from_hour} onChange={(e) => set('alert_from_hour', Number(e.target.value))} aria-label="開始">
                  {hours.slice(0, 24).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
                <select className="select" value={form.alert_to_hour} onChange={(e) => set('alert_to_hour', Number(e.target.value))} aria-label="結束">
                  {hours.slice(1).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            已分配的對話提醒負責同事（要在下面填同事電話）；未分配或同事沒有電話的，提醒負責人。全自動模式下 AI 仍在處理的對話不會提醒。
          </div>
          <div>
            <label className="label">負責人 WhatsApp（未分配的對話提醒這個號碼）</label>
            <input className="input" inputMode="tel" value={form.alert_phone} placeholder="例如 9123 4567" onChange={(e) => set('alert_phone', e.target.value)} />
          </div>
          <div>
            <div className="label">同事 WhatsApp</div>
            <div className="instructor-list">
              {data.team.map((u) => (
                <div key={u.id} className="instructor">
                  <span className="name">{u.name}</span>
                  <input className="input" inputMode="tel" defaultValue={u.phone ? formatPhone(u.phone) : ''} placeholder="WhatsApp 號碼"
                    onBlur={(e) => e.target.value.replace(/\D/g, '') !== u.phone && api(`/users/${u.id}/phone`, { method: 'PATCH', body: { phone: e.target.value } }).then(onSaved)} />
                </div>
              ))}
            </div>
          </div>
        </fieldset>
      </section>

      <section className="card ai-card">
        <div className="ai-card-head"><h2><Icon name="phone" size={18} />通知用號碼</h2></div>
        <fieldset className="form-stack" disabled={!isAdmin}>
          <select className="select" value={form.notify_number_id ?? ''} onChange={(e) => set('notify_number_id', e.target.value ? Number(e.target.value) : null)} aria-label="通知用號碼">
            <option value="">請選擇（未選擇就不會發提醒）</option>
            {numbers.filter((n) => n.channel.startsWith('wa_')).map((n) => <option key={n.id} value={n.id}>{n.label}{n.demo ? '（示範）' : ''}</option>)}
          </select>
          <div className="faint" style={{ fontSize: 12 }}>
            用來發提醒給同事。{sender?.channel === 'wa_cloud' ? '官方 Cloud API 號碼只能在同事 24 小時內傳過訊息給它時發出提醒，建議用 QR 連接的號碼。' : ''}
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
              {saved && <span className="muted" style={{ fontSize: 13 }}>已儲存</span>}
              <button className="btn primary sm" type="button" onClick={save}>儲存所有設定</button>
            </div>
          )}
        </fieldset>
      </section>
    </>
  )
}

function QuickRepliesCard({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<QuickReply[]>([])
  const [editing, setEditing] = useState<Partial<QuickReply> | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => { api<QuickReply[]>('/quick-replies').then(setList) }, [])
  useEffect(() => { load() }, [load])
  const save = async () => {
    setError('')
    try {
      const body = { shortcut: editing!.shortcut, body: editing!.body }
      if (editing!.id) await api(`/quick-replies/${editing!.id}`, { method: 'PUT', body })
      else await api('/quick-replies', { body })
      setEditing(null); load()
    } catch (err) { setError(err instanceof Error ? err.message : '未能儲存') }
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head">
        <h2><Icon name="note" size={18} />快速回覆</h2>
        {isAdmin && <button className="btn sm primary" onClick={() => setEditing({ shortcut: '', body: '' })}><Icon name="plus" size={14} />新增</button>}
      </div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>同事回覆時輸入「/」加捷徑（例如 /價錢），按 Enter 即填入內容。{'{名稱}'} 會換成客人名稱。</p>
      <div className="kb-list">
        {list.length === 0 && <div className="faint" style={{ fontSize: 13 }}>未有快速回覆</div>}
        {list.map((q) => (
          <button key={q.id} className="kb-item" disabled={!isAdmin} onClick={() => setEditing(q)}>
            <div className="kb-top"><b>/{q.shortcut}</b></div>
            <div className="kb-body">{q.body}</div>
          </button>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? '編輯快速回覆' : '新增快速回覆'} onClose={() => setEditing(null)}>
          <div>
            <label className="label" htmlFor="qr-short">捷徑（不用輸入 /）</label>
            <input id="qr-short" className="input" autoFocus value={editing.shortcut ?? ''} placeholder="例如：價錢" onChange={(e) => setEditing({ ...editing, shortcut: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="qr-body">內容</label>
            <textarea id="qr-body" className="textarea" rows={5} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </div>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            {editing.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/quick-replies/${editing.id}`, { method: 'DELETE' }); setEditing(null); load() }}>刪除</button>}
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" disabled={!editing.shortcut?.trim() || !editing.body?.trim()} onClick={save}>儲存</button>
          </div>
        </Modal>
      )}
    </section>
  )
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function ReportCard({ report, isAdmin, onSaved }: { report: Report; isAdmin: boolean; onSaved: () => void }) {
  const [form, setForm] = useState(report)
  const [preview, setPreview] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => setForm(report), [report])
  const save = async () => { await api('/automation/report', { method: 'PUT', body: form }); setMsg('已儲存'); onSaved() }
  const sendNow = async () => {
    setMsg('')
    try { const r = await api<{ sent: number }>('/automation/report/send', { body: {} }); setMsg(`已發送給 ${r.sent} 個號碼`) }
    catch (err) { setMsg(err instanceof Error ? err.message : '發送失敗') }
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="chart" size={18} />每週報告</h2></div>
      <fieldset className="form-stack" disabled={!isAdmin}>
        <label className="toggle-row">
          <input type="checkbox" checked={form.report_enabled} onChange={(e) => setForm({ ...form, report_enabled: e.target.checked })} />
          每星期用 WhatsApp 發送營運報告
        </label>
        <div className="col-pick">
          <div>
            <label className="label">星期幾</label>
            <select className="select" value={form.report_weekday} onChange={(e) => setForm({ ...form, report_weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="label">時間</label>
            <select className="select" value={form.report_hour} onChange={(e) => setForm({ ...form, report_hour: Number(e.target.value) })}>
              {hours.slice(0, 24).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">收報告的 WhatsApp 號碼（多個用逗號分隔）</label>
          <input className="input" inputMode="tel" value={form.report_phones} placeholder="例如 9123 4567, 6123 4567" onChange={(e) => setForm({ ...form, report_phones: e.target.value })} />
        </div>
        {preview && <div className="payslip-message">{preview}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          <button type="button" className="btn ghost sm" onClick={() => api<{ text: string }>('/automation/report/preview').then((r) => setPreview(r.text))}>預覽</button>
          <button type="button" className="btn sm" onClick={sendNow}>立即發送一次</button>
          <button type="button" className="btn primary sm" onClick={save}>儲存</button>
        </div>
      </fieldset>
    </section>
  )
}

function ReviewCard({ review, isAdmin, onSaved }: { review: Overview['review']; isAdmin: boolean; onSaved: () => void }) {
  const [form, setForm] = useState(review)
  const [saved, setSaved] = useState(false)
  useEffect(() => setForm(review), [review])
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="trophy" size={18} />Google 評價邀請</h2></div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>在收件匣對話右邊按「邀請 Google 評價」，就會發以下訊息給客人。</p>
      <fieldset className="form-stack" disabled={!isAdmin}>
        <div>
          <label className="label">Google 評價連結（Google 商家 → 取得更多評論 → 分享連結）</label>
          <input className="input" type="url" value={form.url} placeholder="https://g.page/r/…/review" onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </div>
        <div>
          <label className="label">訊息（{'{名稱}'} = 客人名稱，{'{連結}'} = 評價連結）</label>
          <textarea className="textarea" rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          {saved && <span className="muted" style={{ fontSize: 13 }}>已儲存</span>}
          <button type="button" className="btn primary sm" onClick={async () => { await api('/automation/review', { method: 'PUT', body: form }); setSaved(true); onSaved() }}>儲存</button>
        </div>
      </fieldset>
    </section>
  )
}
