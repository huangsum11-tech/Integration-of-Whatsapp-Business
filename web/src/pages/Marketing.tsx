import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { Icon, Modal } from '../components'
import { formatPhone } from '../format'
import { getSocket } from '../socket'

type Segment = string
interface Audience { segment: Segment; tags: string[] }
interface CampaignSummary {
  id: number; name: string; status: 'draft' | 'scheduled' | 'sending' | 'sent'; scheduled_at: number | null
  created_at: number; sent_at: number | null; number_label: string | null; total: number; sent: number
}
interface Campaign extends Omit<CampaignSummary, 'total' | 'sent'> {
  number_id: number | null; channel: string | null; audience: Audience; message: string
  wa_template_name: string; wa_template_language: string; wa_template_params: string
  ai_note: string; ai_until: number | null
  recipients: { id: number; contact_id: number; name: string; phone: string; status: string; error: string | null; delivered_at: number | null; read_at: number | null; replied: number; conversation_id: number | null }[]
  stats: { total: number; sent: number; failed: number; delivered: number; read: number; replied: number }
}
interface Overview { campaigns: CampaignSummary[]; segments: Record<string, string>; tags: { tag: string; count: number }[]; price: number }

const STATUS: Record<CampaignSummary['status'], [string, string]> = {
  draft: ['', '草稿'], scheduled: ['iris', '已排程'], sending: ['coral', '發送中'], sent: ['pine', '已發送'],
}
const when = (ts: number) => new Date(ts * 1000).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const dateInput = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '')

export default function Marketing() {
  const [tab, setTab] = useState<'broadcast' | 'instagram' | 'customers'>('broadcast')
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>推廣</h1>
          <p>WhatsApp 群發優惠及消息、Instagram 留言自動私訊、客人分組。</p>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ maxWidth: 480, marginBottom: 20 }}>
        {([['broadcast', 'WhatsApp 群發'], ['instagram', 'IG 留言自動私訊'], ['customers', '客人名單']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'broadcast' && <Broadcasts />}
      {tab === 'instagram' && <InstagramRules />}
      {tab === 'customers' && <Customers />}
    </div>
  )
}

// ---------- Broadcasts ----------

function Broadcasts() {
  const [data, setData] = useState<Overview | null>(null)
  const [openId, setOpenId] = useState<number | 'new' | null>(null)
  const load = useCallback(() => { api<Overview>('/campaigns').then(setData) }, [])
  useEffect(() => { load() }, [load])
  if (!data) return null
  return (
    <div className="ai-grid">
      <div className="ai-col">
        {openId ? <CampaignEditor key={openId} id={openId === 'new' ? null : openId} overview={data} onClose={() => { setOpenId(null); load() }} onSaved={(id) => { setOpenId(id); load() }} />
          : (
            <section className="card ai-card">
              <div className="ai-card-head">
                <h2><Icon name="megaphone" size={18} />群發</h2>
                <button className="btn sm primary" onClick={() => setOpenId('new')}><Icon name="plus" size={14} />新增群發</button>
              </div>
              <div className="kb-list">
                {data.campaigns.length === 0 && <div className="faint" style={{ fontSize: 13 }}>未有群發。按「新增群發」開始。</div>}
                {data.campaigns.map((c) => {
                  const [tone, label] = STATUS[c.status]
                  return (
                    <button key={c.id} className="kb-item" onClick={() => setOpenId(c.id)}>
                      <div className="kb-top">
                        <b>{c.name}</b><span className={`chip ${tone}`}>{label}{c.status === 'scheduled' && c.scheduled_at ? `：${when(c.scheduled_at)}` : ''}</span>
                        <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{c.total ? `已發 ${c.sent}／${c.total}` : ''}</span>
                      </div>
                      <div className="faint" style={{ fontSize: 12 }}>{c.number_label ?? '未選號碼'} · 建立於 {when(c.created_at)}</div>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
      </div>
      <div className="ai-col">
        <section className="card ai-card">
          <div className="ai-card-head"><h2><Icon name="shield" size={18} />群發須知</h2></div>
          <ul className="rules">
            <li><b>建議用官方 Cloud API 號碼</b>，並在 Meta 建立「Marketing」類別的模板。Cloud API 主動發訊息一定要用已審批模板。</li>
            <li><b>QR 連接的號碼群發有封號風險</b>。Baton 會逐條慢慢發（每條相隔約 10 秒），但仍建議只發給少量熟客，不要用主要生意號碼大量發送。</li>
            <li>只發給同意接收消息的客人；頻密群發容易被客人封鎖或檢舉。</li>
            <li>Instagram 不容許群發私訊，可以用「IG 留言自動私訊」。</li>
            <li>填寫「AI 需要知道的優惠內容」，客人回覆查詢時 AI 可以直接解答。</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

function CampaignEditor({ id, overview, onClose, onSaved }: { id: number | null; overview: Overview; onClose: () => void; onSaved: (id: number) => void }) {
  const { numbers, me } = useApp()
  const [c, setC] = useState<Campaign | null>(null)
  const [form, setForm] = useState({
    name: '', number_id: null as number | null, audience: { segment: 'all', tags: [] as string[] } as Audience, message: '',
    wa_template_name: '', wa_template_language: 'zh_HK', wa_template_params: '名稱', ai_note: '', ai_until: null as number | null,
  })
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null)
  const [price, setPrice] = useState(overview.price)
  const [when, setWhen] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!id) return
    api<Campaign>(`/campaigns/${id}`).then((x) => {
      setC(x)
      setForm({
        name: x.name, number_id: x.number_id, audience: x.audience, message: x.message, wa_template_name: x.wa_template_name,
        wa_template_language: x.wa_template_language, wa_template_params: x.wa_template_params, ai_note: x.ai_note, ai_until: x.ai_until,
      })
    })
  }, [id])
  useEffect(() => {
    load()
    const socket = getSocket()
    const onCampaign = (e: { id: number }) => { if (e.id === id) load() }
    socket.on('campaign', onCampaign)
    return () => { socket.off('campaign', onCampaign) }
  }, [load, id])
  useEffect(() => {
    const t = setTimeout(() => { api<{ count: number; sample: string[] }>('/audience/preview', { body: form.audience }).then(setPreview) }, 200)
    return () => clearTimeout(t)
  }, [form.audience])

  const locked = c ? c.status !== 'draft' : false
  const sender = numbers.find((n) => n.id === form.number_id)
  const cloud = sender?.channel === 'wa_cloud'
  const act = async (fn: () => Promise<unknown>, done = '') => {
    setError(''); setMsg('')
    try { await fn(); if (done) setMsg(done); load() } catch (err) { setError(err instanceof Error ? err.message : '操作失敗') }
  }
  const save = () => act(async () => {
    const saved = id ? await api<Campaign>(`/campaigns/${id}`, { method: 'PUT', body: form }) : await api<Campaign>('/campaigns', { body: form })
    if (!id) onSaved(saved.id)
  }, '已儲存')
  const toggleTag = (t: string) => setForm({ ...form, audience: { ...form.audience, tags: form.audience.tags.includes(t) ? form.audience.tags.filter((x) => x !== t) : [...form.audience.tags, t] } })

  return (
    <section className="card ai-card">
      <div className="ai-card-head">
        <h2><button className="btn ghost sm" onClick={onClose} aria-label="返回"><Icon name="back" size={16} /></button>{id ? form.name : '新增群發'}</h2>
        {c && <span className={`chip ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}{c.status === 'scheduled' && c.scheduled_at ? `：${new Date(c.scheduled_at * 1000).toLocaleString('zh-HK')}` : ''}</span>}
      </div>

      {c && c.stats.total > 0 && (
        <div className="stat-row">
          {([['對象', c.stats.total], ['已發送', c.stats.sent], ['已送達', c.stats.delivered], ['已讀', c.stats.read], ['有回覆', c.stats.replied], ['失敗', c.stats.failed]] as const).map(([l, v]) => (
            <div key={l}><b>{v}</b><span>{l}</span></div>
          ))}
        </div>
      )}

      <fieldset className="form-stack" disabled={locked}>
        <div className="col-pick">
          <div><label className="label">名稱（內部用）</label><input className="input" value={form.name} placeholder="例如：12 月聖誕優惠" onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div>
            <label className="label">發送號碼</label>
            <select className="select" value={form.number_id ?? ''} onChange={(e) => setForm({ ...form, number_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">請選擇</option>
              {numbers.filter((n) => n.channel !== 'instagram').map((n) => <option key={n.id} value={n.id}>{n.label}{n.channel === 'wa_web' && !n.demo ? '（QR，有封號風險）' : ''}{n.demo ? '（示範）' : ''}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">發給誰</label>
          <select className="select" value={form.audience.segment} onChange={(e) => setForm({ ...form, audience: { ...form.audience, segment: e.target.value } })}>
            {Object.entries(overview.segments).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {overview.tags.length > 0 && (
            <div className="tag-list" style={{ marginTop: 8 }}>
              <span className="faint" style={{ fontSize: 12 }}>只發給有以下任何一個標籤的客人：</span>
              {overview.tags.map((t) => (
                <button key={t.tag} type="button" className={`chip ${form.audience.tags.includes(t.tag) ? 'pine' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => toggleTag(t.tag)}>
                  {form.audience.tags.includes(t.tag) && <Icon name="check" size={11} />}{t.tag}（{t.count}）
                </button>
              ))}
            </div>
          )}
          {preview && (
            <div className="demo-hint" style={{ marginTop: 8 }}>
              共 <b>{preview.count}</b> 位客人{preview.sample.length ? `，例如：${preview.sample.join('、')}` : ''}。
              {cloud && <> 預計費用約 HK${(preview.count * price).toFixed(0)}（每條 HK$
                <input className="input price" type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(Number(e.target.value))}
                  onBlur={() => api('/marketing/price', { method: 'PUT', body: { price } })} />
                ，請以 Meta 價目表為準）。</>}
            </div>
          )}
        </div>
        <div>
          <label className="label">訊息（{'{名稱}'} 會換成客人名稱）{cloud ? '：只在 Baton 收件匣顯示，客人收到的是下面的 Meta 模板' : ''}</label>
          <textarea className="textarea" rows={6} value={form.message} placeholder={'例如：{名稱} 你好！12 月 Reformer 10 堂套票限時 85 折，31/12 前購買有效 🎄 回覆「想報」我哋幫你安排～'}
            onChange={(e) => setForm({ ...form, message: e.target.value })} />
        </div>
        {cloud && (
          <div className="col-pick">
            <div><label className="label">Meta 模板名稱（Marketing）</label><input className="input" value={form.wa_template_name} onChange={(e) => setForm({ ...form, wa_template_name: e.target.value.trim() })} /></div>
            <div><label className="label">語言代碼</label><input className="input" value={form.wa_template_language} onChange={(e) => setForm({ ...form, wa_template_language: e.target.value.trim() })} /></div>
            <div><label className="label">變數 {'{{1}}'}、{'{{2}}'}…</label><input className="input" value={form.wa_template_params} placeholder="名稱" onChange={(e) => setForm({ ...form, wa_template_params: e.target.value })} /></div>
          </div>
        )}
        <div>
          <label className="label">AI 需要知道的優惠內容（客人回覆查詢時 AI 會用；留空則不加入）</label>
          <textarea className="textarea" rows={3} value={form.ai_note} placeholder="例如：12 月優惠：Reformer 10 堂套票原價 $3,500，優惠價 $2,975，31/12 前購買，有效期 4 個月，不可與其他優惠同用。"
            onChange={(e) => setForm({ ...form, ai_note: e.target.value })} />
          <div className="inline-form">
            <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>AI 使用至</span>
            <input className="input" type="date" value={dateInput(form.ai_until)} style={{ maxWidth: 180 }}
              onChange={(e) => setForm({ ...form, ai_until: e.target.value ? Math.floor(new Date(`${e.target.value}T23:59:59`).getTime() / 1000) : null })} />
          </div>
        </div>
        {!locked && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {id && <button type="button" className="btn ghost sm danger" onClick={() => act(async () => { if (confirm('刪除這個群發？')) { await api(`/campaigns/${id}`, { method: 'DELETE' }); onClose() } })}>刪除</button>}
            <button type="button" className="btn primary sm" disabled={!form.name.trim()} onClick={save}>儲存草稿</button>
          </div>
        )}
      </fieldset>

      {id && c && (
        <div className="form-stack" style={{ marginTop: 16, borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
          {c.status === 'draft' && (
            <>
              <div className="inline-form" style={{ marginTop: 0 }}>
                <input className="input" inputMode="tel" placeholder="你的 WhatsApp 號碼" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
                <button className="btn sm" disabled={testPhone.replace(/\D/g, '').length < 8} onClick={() => act(() => api(`/campaigns/${id}/test`, { body: { phone: testPhone } }), '已發送測試訊息')}>先發給自己測試</button>
              </div>
              <div className="run-actions">
                <button className="btn primary sm" onClick={() => act(async () => {
                  if (!confirm(`即時發送給 ${preview?.count ?? 0} 位客人？`)) return
                  await api(`/campaigns/${id}/send`, { body: {} })
                })}><Icon name="send" size={14} />即時發送</button>
                <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="排程時間" style={{ maxWidth: 220 }} />
                <button className="btn sm" disabled={!when} onClick={() => act(() => api(`/campaigns/${id}/send`, { body: { at: Math.floor(new Date(when).getTime() / 1000) } }))}><Icon name="clock" size={14} />排程發送</button>
              </div>
            </>
          )}
          {c.status === 'scheduled' && <button className="btn sm" onClick={() => act(() => api(`/campaigns/${id}/send`, { body: { at: null } }))}>取消排程（之後可以修改）</button>}
          {c.status === 'sent' && c.stats.failed > 0 && <button className="btn sm" onClick={() => act(() => api(`/campaigns/${id}/send`, { body: {} }))}>重發失敗的 {c.stats.failed} 條</button>}
          {msg && <div className="muted" style={{ fontSize: 13 }}>{msg}</div>}
          {error && <div className="error">{error}</div>}
          {c.recipients.length > 0 && (
            <div className="sample" style={{ maxHeight: 360 }}>
              <table className="table">
                <thead><tr><th>客人</th><th>電話</th><th>狀態</th><th>已讀</th><th>回覆</th></tr></thead>
                <tbody>
                  {c.recipients.map((r) => (
                    <tr key={r.id}>
                      <td>{r.conversation_id ? <a href={`#/inbox/${r.conversation_id}`}>{r.name}</a> : r.name}</td>
                      <td className="num muted">{formatPhone(r.phone)}</td>
                      <td>{r.status === 'sent' ? (r.delivered_at ? '已送達' : '已發送') : r.status === 'failed' ? <span className="error" title={r.error ?? ''}>失敗：{r.error}</span> : '等待中'}</td>
                      <td>{r.read_at ? '✓' : ''}</td>
                      <td>{r.replied ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {!id && error && <div className="error">{error}</div>}
      {me.role !== 'admin' && <div className="faint">只有管理員可以群發。</div>}
    </section>
  )
}

// ---------- Instagram comment rules ----------

interface Rule { id: number; number_id: number | null; number_label: string | null; keywords: string; reply: string; public_reply: string; active: number; hits: number }
interface CommentLog { comment_id: string; username: string | null; text: string; status: string; error: string | null; created_at: number; rule_id: number | null }

function InstagramRules() {
  const { numbers } = useApp()
  const [data, setData] = useState<{ rules: Rule[]; comments: CommentLog[] } | null>(null)
  const [editing, setEditing] = useState<Partial<Rule> & { active?: number } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => { api<{ rules: Rule[]; comments: CommentLog[] }>('/ig-rules').then(setData) }, [])
  useEffect(() => {
    load()
    const socket = getSocket()
    socket.on('ig-comment', load)
    return () => { socket.off('ig-comment', load) }
  }, [load])
  const igNumbers = numbers.filter((n) => n.channel === 'instagram')
  const save = async () => {
    setError('')
    try {
      const body = { number_id: editing!.number_id ?? null, keywords: editing!.keywords, reply: editing!.reply, public_reply: editing!.public_reply ?? '', active: editing!.active !== 0 }
      if (editing!.id) await api(`/ig-rules/${editing!.id}`, { method: 'PUT', body })
      else await api('/ig-rules', { body })
      setEditing(null); load()
    } catch (err) { setError(err instanceof Error ? err.message : '未能儲存') }
  }
  if (!data) return null
  return (
    <div className="ai-grid">
      <div className="ai-col">
        <section className="card ai-card">
          <div className="ai-card-head">
            <h2><Icon name="instagram" size={18} />留言關鍵字 → 自動私訊</h2>
            <button className="btn sm primary" onClick={() => setEditing({ keywords: '', reply: '', public_reply: '已私訊你 😊', active: 1 })}><Icon name="plus" size={14} />新增規則</button>
          </div>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
            例如帖子寫「留言 PILATES 取得試堂優惠」，客人一留言就自動收到私訊。客人回覆私訊後，會進入收件匣由 AI／同事跟進。
          </p>
          {igNumbers.length === 0 && <div className="error" style={{ marginBottom: 8 }}>未連接 Instagram 帳戶：請先到「號碼」頁連接。</div>}
          <div className="kb-list">
            {data.rules.length === 0 && <div className="faint" style={{ fontSize: 13 }}>未有規則</div>}
            {data.rules.map((r) => (
              <button key={r.id} className={`kb-item ${r.active ? '' : 'off'}`} onClick={() => setEditing(r)}>
                <div className="kb-top">
                  {r.keywords.split(/[,，、]/).map((k) => <span key={k} className="chip iris">{k.trim()}</span>)}
                  <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>已觸發 {r.hits} 次{r.active ? '' : ' · 已停用'}</span>
                </div>
                <div className="kb-body">{r.reply}</div>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div className="ai-col">
        <section className="card ai-card">
          <div className="ai-card-head"><h2><Icon name="archive" size={18} />最近留言</h2></div>
          <div className="kb-list">
            {data.comments.length === 0 && <div className="faint" style={{ fontSize: 13 }}>未有留言紀錄</div>}
            {data.comments.map((c) => (
              <div key={c.comment_id} className="kb-item" style={{ cursor: 'default' }}>
                <div className="kb-top">
                  <b>@{c.username ?? '?'}</b>
                  <span className={`chip ${c.status === 'sent' ? 'pine' : c.status === 'failed' ? 'coral' : ''}`} style={{ marginLeft: 'auto' }}>
                    {c.status === 'sent' ? '已私訊' : c.status === 'failed' ? '失敗' : '沒有關鍵字'}
                  </span>
                </div>
                <div className="kb-body">{c.text}</div>
                {c.error && <div className="error" style={{ fontSize: 12 }}>{c.error}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>
      {editing && (
        <Modal title={editing.id ? '編輯規則' : '新增規則'} onClose={() => setEditing(null)}>
          {igNumbers.length > 1 && (
            <div>
              <label className="label">Instagram 帳戶</label>
              <select className="select" value={editing.number_id ?? ''} onChange={(e) => setEditing({ ...editing, number_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">所有帳戶</option>
                {igNumbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label">關鍵字（逗號分隔；留言包含任何一個就觸發，不分大小寫）</label>
            <input className="input" autoFocus value={editing.keywords ?? ''} placeholder="例如：PILATES, 試堂, 想試" onChange={(e) => setEditing({ ...editing, keywords: e.target.value })} />
          </div>
          <div>
            <label className="label">自動私訊內容</label>
            <textarea className="textarea" rows={5} value={editing.reply ?? ''} placeholder="例如：多謝留言！🎁 首次試堂只需 $180，按呢度預約：https://… 有問題直接喺度問我哋就得 😊"
              onChange={(e) => setEditing({ ...editing, reply: e.target.value })} />
          </div>
          <div>
            <label className="label">公開回覆留言（可選，留空則不回覆）</label>
            <input className="input" value={editing.public_reply ?? ''} onChange={(e) => setEditing({ ...editing, public_reply: e.target.value })} />
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={editing.active !== 0} onChange={(e) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })} />啟用
          </label>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            {editing.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/ig-rules/${editing.id}`, { method: 'DELETE' }); setEditing(null); load() }}>刪除</button>}
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" disabled={!editing.keywords?.trim() || !editing.reply?.trim()} onClick={save}>儲存</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------- Customers: tags and import ----------

function Customers() {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [tag, setTag] = useState('')
  const [msg, setMsg] = useState('')
  const load = useCallback(() => { api<{ tag: string; count: number }[]>('/tags').then(setTags) }, [])
  useEffect(() => { load() }, [load])
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setMsg('')
    try {
      const r = await api<{ added: number; updated: number }>('/contacts/import', { body: { csv: await file.text(), tag } })
      setMsg(`已匯入：新增 ${r.added} 位，更新 ${r.updated} 位。`)
      load()
    } catch (err) { setMsg(err instanceof Error ? err.message : '匯入失敗') }
  }
  return (
    <div className="ai-grid">
      <div className="ai-col">
        <section className="card ai-card">
          <div className="ai-card-head"><h2><Icon name="contacts" size={18} />匯入客人名單</h2></div>
          <ol className="steps" style={{ marginTop: 0 }}>
            <li>在 Vibefam 匯出會員／客人名單，或自己整理一個 Excel，存成 CSV</li>
            <li>要有「電話」欄；可以有「姓名」和「標籤」欄（多個標籤用逗號分隔）</li>
            <li>已有的客人不會重複，只會加上標籤</li>
          </ol>
          <div className="inline-form">
            <input className="input" placeholder="全部加上這個標籤（可選），例如：會員" value={tag} onChange={(e) => setTag(e.target.value)} />
            <label className="btn sm">
              <Icon name="file" size={14} />選擇 CSV
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          </div>
          {msg && <div className="demo-hint" style={{ marginTop: 10 }}>{msg}</div>}
        </section>
      </div>
      <div className="ai-col">
        <section className="card ai-card">
          <div className="ai-card-head"><h2><Icon name="check" size={18} />標籤</h2></div>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>在收件匣對話右邊可以為客人加減標籤，群發時按標籤選對象。</p>
          <div className="tag-list">
            {tags.length === 0 && <span className="faint" style={{ fontSize: 13 }}>未有標籤</span>}
            {tags.map((t) => <span key={t.tag} className="chip pine">{t.tag}（{t.count}）</span>)}
          </div>
        </section>
      </div>
    </div>
  )
}
