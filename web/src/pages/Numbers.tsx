import { useEffect, useState } from 'react'
import { api, type Channel, type ReplyMode, type WaNumber } from '../api'
import { useApp } from '../App'
import { Icon, Modal, NumberStatus, type IconName } from '../components'
import { formatPhone } from '../format'

const CHANNELS: { id: Channel; icon: IconName; title: string; text: string }[] = [
  { id: 'wa_cloud', icon: 'shield', title: 'WhatsApp 官方 Cloud API（建議）', text: 'Meta 官方接口，適合 AI 自動回覆。需要 Meta App、電話號碼 ID 和永久權杖。' },
  { id: 'instagram', icon: 'instagram', title: 'Instagram DM', text: '經 Instagram 官方 API 接收及回覆私訊、留言自動私訊。需要 Instagram 專業帳戶。' },
  { id: 'messenger', icon: 'facebook', title: 'Facebook Messenger', text: '回覆 Facebook 專頁私訊、專頁留言自動私訊。需要專頁 ID 和專頁存取權杖。' },
  { id: 'threads', icon: 'threads', title: 'Threads 留言', text: 'Threads 沒有私訊 API：讀取你帖子下的留言並公開回覆。' },
  { id: 'wa_web', icon: 'qr', title: 'WhatsApp（掃 QR Code，非官方）', text: '用現有的 WhatsApp Business App 號碼，一分鐘連接。只建議人手回覆，自動回覆有封號風險。' },
]
const CHANNEL_ICON: Record<Channel, IconName> = { wa_web: 'phone', wa_cloud: 'phone', instagram: 'instagram', messenger: 'facebook', threads: 'threads' }

const MODES: { id: ReplyMode; label: string; hint: string }[] = [
  { id: 'off', label: '關閉', hint: '同事手動回覆，可隨時按「AI 草擬」' },
  { id: 'suggest', label: 'AI 建議', hint: 'AI 預先寫好回覆，同事確認後一按發送' },
  { id: 'auto', label: '全自動', hint: 'AI 直接回覆客人，不確定時轉交同事' },
]

export default function Numbers() {
  const { numbers, me, refreshNumbers } = useApp()
  const [adding, setAdding] = useState(false)
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const isAdmin = me.role === 'admin'
  const linking = numbers.find((n) => n.id === linkingId)
  const [setupKey, setSetupKey] = useState(0)

  const [syncing, setSyncing] = useState<number | null>(null)
  const [syncResult, setSyncResult] = useState('')
  const syncContacts = async (id: number) => {
    setSyncing(id); setSyncResult('')
    try {
      const r = await api<{ resolved: number; unresolved: number }>(`/numbers/${id}/sync-contacts`, { method: 'POST' })
      setSyncResult(r.unresolved
        ? `已同步通訊錄名稱，補回 ${r.resolved} 個電話號碼。仍有 ${r.unresolved} 位客戶的號碼被 WhatsApp 隱藏，佢哋下次傳訊息時會自動補上。`
        : `已同步通訊錄名稱，補回 ${r.resolved} 個電話號碼。`)
    } catch (err) {
      setSyncResult(err instanceof Error ? err.message : '同步失敗')
    } finally {
      setSyncing(null)
    }
  }
  const reconnect = async (id: number) => { await api(`/numbers/${id}/reconnect`, { method: 'POST' }); setLinkingId(id) }
  const unlink = async (n: WaNumber) => {
    const what = n.channel === 'wa_web' ? '解除連結後不會再收到新訊息' : '會刪除儲存的存取權杖，之後不會再收發訊息'
    if (!confirm(`${what}，但已備份的對話與聯絡人會保留。確定？`)) return
    await api(`/numbers/${n.id}/unlink`, { method: 'POST' }); refreshNumbers()
  }
  const setMode = async (n: WaNumber, reply_mode: ReplyMode) => {
    if (reply_mode === 'auto' && n.channel === 'wa_web' && !n.demo &&
      !confirm('QR Code 連接是非官方方式。讓 AI 全自動回覆，號碼被 WhatsApp 限制或封鎖的風險會較高。建議改用官方 Cloud API。仍然開啟？')) return
    await api(`/numbers/${n.id}`, { method: 'PATCH', body: { reply_mode } })
    refreshNumbers(); setSetupKey((k) => k + 1)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>號碼與帳戶</h1>
          <p>連接 WhatsApp、Instagram、Facebook Messenger 和 Threads，並設定每個帳戶的 AI 回覆方式。</p>
        </div>
      </div>

      <SetupChecklist key={setupKey} />
      {syncResult && <div className="demo-hint" style={{ marginBottom: 16 }}>{syncResult}</div>}
      <div className="number-cards">
        {numbers.map((n) => {
          const channel = CHANNELS.find((c) => c.id === n.channel) ?? CHANNELS[0]
          const official = n.channel !== 'wa_web'
          return (
            <div key={n.id} className="card number-card">
              <div className="top">
                <div className="icon"><Icon name={CHANNEL_ICON[n.channel] ?? 'phone'} size={22} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{n.label}</div>
                  <div className="muted num" style={{ fontSize: 13 }}>{formatPhone(n.phone) || '尚未連接'}</div>
                </div>
                <NumberStatus status={official && n.status === 'connected' ? 'connected_api' : n.status} />
              </div>
              <div className="faint" style={{ fontSize: 12 }}>{n.demo ? '示範號碼' : channel.title}</div>
              <div className="stats">
                <div><b>{n.conversations}</b>對話</div>
              </div>
              <div>
                <div className="label">AI 回覆方式</div>
                <div className="tabs" role="radiogroup" aria-label={`${n.label} 的 AI 回覆方式`}>
                  {MODES.map((m) => (
                    <button key={m.id} role="radio" aria-checked={n.reply_mode === m.id} title={m.hint} disabled={!isAdmin}
                      className={`tab ${n.reply_mode === m.id ? 'active' : ''}`} onClick={() => n.reply_mode !== m.id && setMode(n, m.id)}>
                      {m.id !== 'off' && <Icon name="sparkle" size={12} />} {m.label}
                    </button>
                  ))}
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{MODES.find((m) => m.id === n.reply_mode)?.hint}</div>
              </div>
              {isAdmin && !n.demo && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!official && n.status !== 'connected' && <button className="btn sm primary" onClick={() => reconnect(n.id)}><Icon name="qr" size={14} />{n.status === 'qr' ? '顯示 QR Code' : '重新連接'}</button>}
                  {!official && n.status === 'connected' && <button className="btn sm" disabled={syncing === n.id} onClick={() => syncContacts(n.id)}><Icon name="contacts" size={14} />{syncing === n.id ? '同步中…' : '同步聯絡人'}</button>}
                  {n.status !== 'unlinked' && <button className="btn sm danger" onClick={() => unlink(n)}>{official ? '中斷連接' : '解除連結'}</button>}
                </div>
              )}
            </div>
          )
        })}
        {isAdmin && (
          <button className="add-card" onClick={() => setAdding(true)}>
            <Icon name="plus" size={26} />
            <b>連接新號碼或帳戶</b>
            <span style={{ fontSize: 12 }}>WhatsApp、Instagram、Facebook、Threads</span>
          </button>
        )}
      </div>

      {adding && <AddModal onClose={() => setAdding(false)} onCreated={(id, channel, warning) => {
        setAdding(false); refreshNumbers(); setSetupKey((k) => k + 1)
        if (warning) setSyncResult(warning)
        if (channel === 'wa_web') setLinkingId(id)
      }} />}

      {linking && (
        <Modal title={`連接「${linking.label}」`} onClose={() => setLinkingId(null)}>
          <div className="qr-box">
            {linking.status === 'connected' ? (
              <div style={{ textAlign: 'center', color: 'var(--pine)' }}>
                <Icon name="check" size={48} />
                <p style={{ color: 'var(--text)' }}><b>已連接 {formatPhone(linking.phone)}</b><br /><span className="muted">正在同步對話紀錄，可以開始使用。</span></p>
              </div>
            ) : linking.qr ? <img src={linking.qr} alt="WhatsApp 連結 QR Code" /> : <span className="muted">正在產生 QR Code…</span>}
          </div>
          {linking.status !== 'connected' && (
            <ol className="steps">
              <li>在手機打開 <b>WhatsApp Business</b></li>
              <li>前往 <b>設定 → 已連結的裝置 → 連結裝置</b></li>
              <li>用手機掃描上面的 QR Code</li>
            </ol>
          )}
          <div className="modal-actions">
            <button className="btn primary" onClick={() => setLinkingId(null)}>{linking.status === 'connected' ? '完成' : '稍後再做'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

const WEBHOOK_FIELDS: Partial<Record<Channel, string>> = {
  wa_cloud: 'messages',
  instagram: 'messages, comments',
  messenger: 'messages, message_echoes, feed',
}

function AddModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number, channel: Channel, warning?: string) => void }) {
  const [channel, setChannel] = useState<Channel | null>(null)
  const [form, setForm] = useState({ label: '', phoneNumberId: '', pageId: '', accessToken: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const webhookUrl = `${window.location.origin}/webhooks/meta`

  const create = async () => {
    if (!channel) return
    setBusy(true); setError('')
    try {
      const body = channel === 'wa_web' ? { channel, label: form.label }
        : channel === 'wa_cloud' ? { channel, label: form.label, phoneNumberId: form.phoneNumberId, accessToken: form.accessToken }
        : channel === 'messenger' ? { channel, label: form.label, pageId: form.pageId, accessToken: form.accessToken }
        : { channel, label: form.label, accessToken: form.accessToken }
      const { id, warning } = await api<{ id: number; warning?: string }>('/numbers', { body })
      onCreated(id, channel, warning)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未能連接')
    } finally {
      setBusy(false)
    }
  }

  if (!channel) {
    return (
      <Modal title="連接新號碼或帳戶" onClose={onClose}>
        <div className="channel-list">
          {CHANNELS.map((c) => (
            <button key={c.id} className="channel-option" onClick={() => setChannel(c.id)}>
              <div className="icon"><Icon name={c.icon} size={20} /></div>
              <div><b>{c.title}</b><div className="muted" style={{ fontSize: 13 }}>{c.text}</div></div>
            </button>
          ))}
        </div>
        <div className="modal-actions"><button className="btn" onClick={onClose}>取消</button></div>
      </Modal>
    )
  }

  const ready = form.label && (channel === 'wa_web' || (form.accessToken
    && (channel !== 'wa_cloud' || form.phoneNumberId) && (channel !== 'messenger' || form.pageId)))
  const token = (label: string) => (
    <div>
      <label className="label" htmlFor="num-token">{label}</label>
      <input id="num-token" className="input" type="password" autoComplete="off" value={form.accessToken}
        onChange={(e) => setForm({ ...form, accessToken: e.target.value.trim() })} />
    </div>
  )
  return (
    <Modal title={CHANNELS.find((c) => c.id === channel)!.title} onClose={onClose}>
      <div>
        <label className="label" htmlFor="num-label">名稱（團隊內部用）</label>
        <input id="num-label" className="input" autoFocus placeholder={channel.startsWith('wa_') ? '例如：客戶熱線、旺角分店' : '例如：主帳戶'}
          value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </div>
      {channel === 'wa_cloud' && (
        <>
          <div>
            <label className="label" htmlFor="num-pnid">電話號碼 ID（Phone number ID）</label>
            <input id="num-pnid" className="input num" inputMode="numeric" placeholder="在 Meta App → WhatsApp → API 設定找到"
              value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value.trim() })} />
          </div>
          {token('永久存取權杖（System User access token）')}
        </>
      )}
      {channel === 'instagram' && token('Instagram 存取權杖（Instagram API with Instagram Login）')}
      {channel === 'messenger' && (
        <>
          <div>
            <label className="label" htmlFor="num-page">Facebook 專頁 ID（Page ID）</label>
            <input id="num-page" className="input num" inputMode="numeric" placeholder="專頁 →「關於」→ 專頁透明度，或 Meta App → Messenger 設定"
              value={form.pageId} onChange={(e) => setForm({ ...form, pageId: e.target.value.trim() })} />
          </div>
          {token('專頁存取權杖（Page access token，建議用系統用戶產生的永久權杖）')}
        </>
      )}
      {channel === 'threads' && token('Threads 長期存取權杖（long-lived access token）')}
      {WEBHOOK_FIELDS[channel] && (
        <div className="demo-hint">
          在 Meta App 的 Webhooks 設定：<br />
          回呼網址：<code>{webhookUrl}</code><br />
          驗證權杖：伺服器環境變數 <code>META_VERIFY_TOKEN</code> 的值<br />
          訂閱欄位：<code>{WEBHOOK_FIELDS[channel]}</code>
          {window.location.protocol !== 'https:' && <><br />⚠️ Meta 只接受 HTTPS 網址，開發時可用 ngrok 或 Cloudflare Tunnel。</>}
        </div>
      )}
      {channel === 'threads' && (
        <div className="demo-hint">
          Threads 沒有私訊 API：Baton 每 3 分鐘讀取你最近 7 日帖子下的留言，回覆會<b>公開</b>貼在客人留言下面。建議這個帳戶用「AI 建議」模式。
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={() => setChannel(null)}>上一步</button>
        <button className="btn primary" disabled={!ready || busy} onClick={create}>
          {busy ? '驗證中…' : channel === 'wa_web' ? '下一步：掃描 QR Code' : '驗證並連接'}
        </button>
      </div>
    </Modal>
  )
}

interface Check { id: string; label: string; ok: boolean; optional?: boolean; detail: string; page: string }

/** What is done and what is left before the AI can answer customers on every channel. */
function SetupChecklist() {
  const [checks, setChecks] = useState<Check[]>([])
  const [open, setOpen] = useState(true)
  useEffect(() => { api<Check[]>('/setup-status').then(setChecks) }, [])
  if (!checks.length) return null
  const required = checks.filter((c) => !c.optional)
  const done = required.filter((c) => c.ok).length
  return (
    <section className="card ai-card setup-card">
      <div className="ai-card-head">
        <h2><Icon name="check" size={18} />設定清單（必需 {done}／{required.length}）</h2>
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? '收起' : '展開'}</button>
      </div>
      {open && (
        <div className="checklist">
          {checks.map((c) => (
            <a key={c.id} className={`check ${c.ok ? 'ok' : ''}`} href={`#/${c.page}`}>
              <span className="mark">{c.ok ? <Icon name="check" size={14} /> : null}</span>
              <span><b>{c.label}</b>{c.optional && <span className="faint">（可選）</span>}<br /><span className="muted">{c.detail}</span></span>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}
