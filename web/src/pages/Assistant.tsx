import { useCallback, useEffect, useState } from 'react'
import { api, type AiSettings, type Knowledge, type KnowledgeCategory } from '../api'
import { useApp } from '../App'
import { Icon, Modal } from '../components'
import { BrandSelect } from './BrandSelect'

const CATEGORIES: { id: KnowledgeCategory; label: string; hint: string }[] = [
  { id: 'faq', label: '常見問題', hint: '設定關鍵字後，客人問到就直接用這段答案回覆，不經 AI' },
  { id: 'policy', label: '公司政策', hint: '例如：取消及改期、退款、套票有效期、遲到安排' },
  { id: 'class', label: '課程資料', hint: '例如：課程種類、程度、時間表、價錢、導師' },
  { id: 'other', label: '其他', hint: '例如：地址、交通、泊車、要帶甚麼' },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<KnowledgeCategory, string>

type Draft = Omit<Knowledge, 'id' | 'updated_at' | 'active'> & { id?: number; active: boolean }

export default function Assistant() {
  const { me } = useApp()
  const isAdmin = me.role === 'admin'
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [entries, setEntries] = useState<Knowledge[]>([])
  const [filter, setFilter] = useState<KnowledgeCategory | 'all'>('all')
  const [editing, setEditing] = useState<Draft | null>(null)

  const loadSettings = useCallback(() => { api<AiSettings>('/ai/settings').then(setSettings) }, [])
  const loadEntries = useCallback(() => { api<Knowledge[]>('/knowledge').then(setEntries) }, [])
  useEffect(() => { loadSettings(); loadEntries() }, [loadSettings, loadEntries])

  const shown = filter === 'all' ? entries : entries.filter((e) => e.category === filter)
  const [importMsg, setImportMsg] = useState('')
  const runImport = async (body: { csv?: string; template?: boolean; replace?: boolean }) => {
    setImportMsg('')
    try {
      const r = await api<{ added: number; updated: number }>('/knowledge/import', { body })
      setImportMsg(`已匯入：新增 ${r.added} 項，更新 ${r.updated} 項。`)
      loadEntries()
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : '匯入失敗')
    }
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    const replace = entries.length > 0 && confirm('要用這個檔案「取代」整個知識庫嗎？\n\n按「確定」：檔案以外的資料會被刪除\n按「取消」：只新增及更新檔案內的項目')
    runImport({ csv: await file.text(), replace })
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI 助手</h1>
          <p>AI 只會根據這裏的公司資料和知識庫回答客人；資料以外的問題會轉交同事。</p>
        </div>
      </div>

      <div className="ai-grid">
        <div className="ai-col">
          {settings && <BusinessCard settings={settings} isAdmin={isAdmin} onSaved={loadSettings} />}

          <section className="card ai-card">
            <div className="ai-card-head">
              <h2><Icon name="book" size={18} />知識庫</h2>
              {isAdmin && (
                <button className="btn sm primary" onClick={() => setEditing({ category: filter === 'all' ? 'policy' : filter, brand_id: null, title: '', body: '', keywords: '', active: true })}>
                  <Icon name="plus" size={14} />新增
                </button>
              )}
            </div>
            {isAdmin && (
              <div className="kb-tools">
                <a className="btn sm ghost" href="/api/knowledge/template.csv" download>下載範本 CSV</a>
                <a className="btn sm ghost" href="/api/knowledge/export.csv" download>匯出 CSV</a>
                <label className="btn sm ghost">
                  匯入 CSV
                  <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} />
                </label>
                <span className="faint">可以用 Excel／Google Sheets 編輯後再匯入</span>
              </div>
            )}
            {importMsg && <div className="demo-hint" style={{ marginBottom: 10 }}>{importMsg}</div>}
            <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
              {[{ id: 'all' as const, label: '全部' }, ...CATEGORIES].map((c) => (
                <button key={c.id} role="tab" aria-selected={filter === c.id} className={`tab ${filter === c.id ? 'active' : ''}`} onClick={() => setFilter(c.id)}>
                  {c.label}
                  <span className="count">{c.id === 'all' ? entries.length : entries.filter((e) => e.category === c.id).length}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 && (
              <div className="faint" style={{ fontSize: 13, padding: '12px 0' }}>
                {entries.length === 0 ? '未有資料。先加入課程、價錢和取消政策，AI 才能準確回答客人。' : '這個分類未有資料'}
                {entries.length === 0 && isAdmin && (
                  <div style={{ marginTop: 10 }}>
                    <button className="btn sm" onClick={() => runImport({ template: true })}><Icon name="book" size={14} />載入普拉提／健身室範本</button>
                    <div style={{ marginTop: 4 }}>範本內 [方括號] 的地方請改成你們的資料。</div>
                  </div>
                )}
              </div>
            )}
            <div className="kb-list">
              {shown.map((e) => (
                <button key={e.id} className={`kb-item ${e.active ? '' : 'off'}`} disabled={!isAdmin}
                  onClick={() => setEditing({ ...e, active: Boolean(e.active) })}>
                  <div className="kb-top">
                    <span className="chip">{CATEGORY_LABEL[e.category]}</span>
                    <b>{e.title}</b>
                    {!e.active && <span className="chip coral">已停用</span>}
                  </div>
                  <div className="kb-body">{e.body}</div>
                  {e.category === 'faq' && e.keywords && <div className="faint" style={{ fontSize: 12 }}>關鍵字：{e.keywords}</div>}
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="ai-col">
          <TestCard />
          {settings && <ModelCard settings={settings} isAdmin={isAdmin} onSaved={loadSettings} />}
        </div>
      </div>

      {editing && <KnowledgeModal draft={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); loadEntries() }} />}
    </div>
  )
}

function BusinessCard({ settings, isAdmin, onSaved }: { settings: AiSettings; isAdmin: boolean; onSaved: () => void }) {
  const pick = (s: AiSettings) => ({
    business_name: s.business_name, business_intro: s.business_intro, handoff_message: s.handoff_message,
    trial_booking_url: s.trial_booking_url, booking_url: s.booking_url,
  })
  const [form, setForm] = useState(pick(settings))
  const [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(settings))
  const save = async () => {
    await api('/ai/settings', { method: 'PUT', body: form })
    setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2000)
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="user" size={18} />公司資料</h2></div>
      <div className="form-stack">
        <div>
          <label className="label" htmlFor="biz-name">公司名稱</label>
          <input id="biz-name" className="input" disabled={!isAdmin} value={form.business_name} placeholder="例如：Core Studio 普拉提"
            onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="biz-intro">簡介（AI 每次回覆都會參考）</label>
          <textarea id="biz-intro" className="textarea" rows={4} disabled={!isAdmin} value={form.business_intro}
            placeholder="例如：旺角普拉提工作室，提供 Reformer 及墊上課程，小班教學（最多 6 人）。營業時間：星期一至六 7am–10pm。地址：…"
            onChange={(e) => setForm({ ...form, business_intro: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="biz-handoff">轉交同事時自動發給客人的訊息（全自動模式；留空則不發）</label>
          <input id="biz-handoff" className="input" disabled={!isAdmin} value={form.handoff_message}
            placeholder="例如：收到！我已經通知同事，佢哋會盡快回覆你 🙏"
            onChange={(e) => setForm({ ...form, handoff_message: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="biz-trial">首次試堂預約連結（AI 只會給第一次上堂的新客人）</label>
          <input id="biz-trial" className="input" type="url" disabled={!isAdmin} value={form.trial_booking_url}
            placeholder="例如 Vibefam 試堂 / Intro Offer 的預約頁面網址"
            onChange={(e) => setForm({ ...form, trial_booking_url: e.target.value.trim() })} />
        </div>
        <div>
          <label className="label" htmlFor="biz-booking">一般預約連結（已上過堂的學生自己預約）</label>
          <input id="biz-booking" className="input" type="url" disabled={!isAdmin} value={form.booking_url}
            placeholder="例如 Vibefam 時間表／App 下載頁"
            onChange={(e) => setForm({ ...form, booking_url: e.target.value.trim() })} />
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {saved && <span className="muted" style={{ fontSize: 13 }}>已儲存</span>}
            <button className="btn primary sm" disabled={!dirty} onClick={save}>儲存</button>
          </div>
        )}
      </div>
    </section>
  )
}

function ModelCard({ settings, isAdmin, onSaved }: { settings: AiSettings; isAdmin: boolean; onSaved: () => void }) {
  const [provider, setProvider] = useState(settings.provider)
  const current = settings.providers.find((p) => p.id === provider)!
  const [model, setModel] = useState(current.model)
  useEffect(() => { setModel(settings.providers.find((p) => p.id === provider)!.model) }, [provider, settings])
  const dirty = provider !== settings.provider || model !== current.model
  const save = async () => {
    await api('/ai/settings', { method: 'PUT', body: { provider, model: model === current.defaultModel ? '' : model } })
    onSaved()
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="bot" size={18} />AI 模型</h2></div>
      <div className="provider-list" role="radiogroup" aria-label="AI 供應商">
        {settings.providers.map((p) => (
          <label key={p.id} className={`provider ${provider === p.id ? 'active' : ''}`}>
            <input type="radio" name="provider" disabled={!isAdmin} checked={provider === p.id} onChange={() => setProvider(p.id)} />
            <span style={{ flex: 1 }}>{p.label}</span>
            {p.hasKey ? <span className="chip pine">已設定金鑰</span> : <span className="chip coral">未設定 {p.keyEnv}</span>}
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <label className="label" htmlFor="ai-model">模型</label>
        <input id="ai-model" className="input num" disabled={!isAdmin} value={model} onChange={(e) => setModel(e.target.value)} />
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          預設：{current.defaultModel}。API 金鑰在伺服器的環境變數設定，不會儲存在資料庫。
        </div>
      </div>
      {isAdmin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn primary sm" disabled={!dirty || !model.trim()} onClick={save}>儲存</button>
        </div>
      )}
    </section>
  )
}

function TestCard() {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ action: 'reply' | 'handoff'; text?: string; reason?: string; source: 'faq' | 'ai'; trial?: { at: number; className: string } } | null>(null)
  const [error, setError] = useState('')
  const ask = async () => {
    if (!question.trim()) return
    setBusy(true); setError(''); setResult(null)
    try {
      setResult(await api('/ai/test', { body: { question } }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '測試失敗')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card ai-card">
      <div className="ai-card-head"><h2><Icon name="sparkle" size={18} />試問 AI</h2></div>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>扮客人問一條問題，看看 AI 會怎樣答。不會發送給任何人。</p>
      <div className="inline-form" style={{ marginTop: 0 }}>
        <input className="input" value={question} placeholder="例如：第一次上堂要帶咩？／腰痛可以做普拉提嗎？"
          onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && ask()} />
        <button className="btn ai sm" disabled={busy || !question.trim()} onClick={ask}>{busy ? '思考中…' : '發問'}</button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      {result && (
        result.action === 'reply' ? (
          <div className="test-answer">
            <div className="bubble ai">{result.text}</div>
            <span className={`chip ${result.source === 'faq' ? 'pine' : 'iris'}`}>
              {result.source === 'faq' ? '常見問題：按關鍵字直接回覆（不經 AI）' : 'AI 根據知識庫回覆'}
            </span>
            {result.trial && (
              <span className="chip pine">
                <Icon name="clock" size={12} />
                會記錄試堂：{new Date(result.trial.at * 1000).toLocaleString('zh-HK', { dateStyle: 'medium', timeStyle: 'short' })} {result.trial.className}
              </span>
            )}
          </div>
        ) : (
          <div className="test-answer handoff">
            <Icon name="handoff" size={16} />
            <span>AI 會轉交同事處理：{result.reason}</span>
          </div>
        )
      )}
    </section>
  )
}

function KnowledgeModal({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(draft)
  const [error, setError] = useState('')
  const category = CATEGORIES.find((c) => c.id === form.category)!
  const save = async () => {
    setError('')
    try {
      const body = { category: form.category, brand_id: form.brand_id ?? null, title: form.title, body: form.body, keywords: form.category === 'faq' ? form.keywords : '', active: form.active }
      if (form.id) await api(`/knowledge/${form.id}`, { method: 'PUT', body })
      else await api('/knowledge', { body })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗')
    }
  }
  const remove = async () => {
    if (!form.id || !confirm(`刪除「${form.title}」？`)) return
    await api(`/knowledge/${form.id}`, { method: 'DELETE' })
    onSaved()
  }
  return (
    <Modal title={form.id ? '編輯資料' : '新增資料'} onClose={onClose}>
      <div>
        <label className="label" htmlFor="kb-brand">適用品牌</label>
        <BrandSelect id="kb-brand" value={form.brand_id ?? null} emptyLabel="所有品牌" onChange={(brand_id) => setForm({ ...form, brand_id })} />
      </div>
      <div>
        <label className="label" htmlFor="kb-cat">分類</label>
        <select id="kb-cat" className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as KnowledgeCategory })}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{category.hint}</div>
      </div>
      <div>
        <label className="label" htmlFor="kb-title">{form.category === 'faq' ? '問題' : '標題'}</label>
        <input id="kb-title" className="input" autoFocus value={form.title} placeholder={form.category === 'faq' ? '例如：有冇試堂？' : '例如：取消及改期政策'}
          onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="kb-body">{form.category === 'faq' ? '答案（會原文發給客人）' : '內容'}</label>
        <textarea id="kb-body" className="textarea" rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
          placeholder={form.category === 'faq' ? '例如：有呀！首堂體驗價 $180，WhatsApp 話我知想上邊日就得 😊' : '例如：上堂前 24 小時可免費改期一次；24 小時內取消會扣除該堂。'} />
      </div>
      {form.category === 'faq' && (
        <div>
          <label className="label" htmlFor="kb-keywords">關鍵字（用逗號分隔；客人訊息包含任何一個就直接回覆）</label>
          <input id="kb-keywords" className="input" value={form.keywords} placeholder="例如：試堂, trial, 體驗"
            onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
        </div>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        啟用（停用後 AI 不會使用這段資料）
      </label>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        {form.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>刪除</button>}
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!form.title.trim() || !form.body.trim()} onClick={save}>儲存</button>
      </div>
    </Modal>
  )
}
