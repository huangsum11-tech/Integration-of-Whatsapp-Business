import { useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { Icon, Modal, NumberStatus } from '../components'
import { formatPhone } from '../format'

export default function Numbers() {
  const { numbers, me, refreshNumbers } = useApp()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const isAdmin = me.role === 'admin'
  const linking = numbers.find((n) => n.id === linkingId)

  const create = async () => {
    setError('')
    try {
      const { id } = await api<{ id: number }>('/numbers', { body: { label } })
      setAdding(false); setLabel(''); setLinkingId(id); refreshNumbers()
    } catch (err) {
      setError(err instanceof Error ? err.message : '未能新增號碼')
    }
  }
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
  const unlink = async (id: number) => {
    if (!confirm('解除連結後不會再收到新訊息，但已備份的對話與聯絡人會保留。確定？')) return
    await api(`/numbers/${id}/unlink`, { method: 'POST' }); refreshNumbers()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>WhatsApp 號碼</h1>
          <p>連接你現有的 WhatsApp Business 號碼。號碼不變，客戶照舊搵你。</p>
        </div>
      </div>
      <div className="promise">
        <span><Icon name="qr" size={16} />掃 QR Code 即用，約一分鐘</span>
        <span><Icon name="shield" size={16} />毋須申請 Platform API 或商業驗證</span>
        <span><Icon name="archive" size={16} />由連接一刻起自動備份</span>
      </div>

      {syncResult && <div className="demo-hint" style={{ marginBottom: 16 }}>{syncResult}</div>}
      <div className="number-cards">
        {numbers.map((n) => (
          <div key={n.id} className="card number-card">
            <div className="top">
              <div className="icon"><Icon name="phone" size={22} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{n.label}</div>
                <div className="muted num" style={{ fontSize: 13 }}>{formatPhone(n.phone) || '尚未連接'}</div>
              </div>
              <NumberStatus status={n.status} />
            </div>
            <div className="stats">
              <div><b>{n.conversations}</b>對話</div>
            </div>
            {isAdmin && !n.demo && (
              <div style={{ display: 'flex', gap: 8 }}>
                {n.status !== 'connected' && <button className="btn sm primary" onClick={() => reconnect(n.id)}><Icon name="qr" size={14} />{n.status === 'qr' ? '顯示 QR Code' : '重新連接'}</button>}
                {n.status === 'connected' && <button className="btn sm" disabled={syncing === n.id} onClick={() => syncContacts(n.id)}><Icon name="contacts" size={14} />{syncing === n.id ? '同步中…' : '同步聯絡人'}</button>}
                {n.status !== 'unlinked' && <button className="btn sm danger" onClick={() => unlink(n.id)}>解除連結</button>}
              </div>
            )}
          </div>
        ))}
        {isAdmin && (
          <button className="add-card" onClick={() => setAdding(true)}>
            <Icon name="plus" size={26} />
            <b>連接新號碼</b>
            <span style={{ fontSize: 12 }}>用手機掃描 QR Code</span>
          </button>
        )}
      </div>

      {adding && (
        <Modal title="連接新號碼" onClose={() => setAdding(false)}>
          <div>
            <label className="label" htmlFor="num-label">號碼名稱（團隊內部用）</label>
            <input id="num-label" className="input" autoFocus placeholder="例如：銷售熱線、旺角分店" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && label && create()} />
          </div>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={() => setAdding(false)}>取消</button>
            <button className="btn primary" disabled={!label} onClick={create}>下一步：掃描 QR Code</button>
          </div>
        </Modal>
      )}

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
