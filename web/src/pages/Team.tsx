import { useState } from 'react'
import { api, type User } from '../api'
import { useApp } from '../App'
import { Avatar, Icon, Modal } from '../components'

export default function Team() {
  const { users, me, refreshUsers, setMe } = useApp()
  const [inviting, setInviting] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' })
  const [offboarding, setOffboarding] = useState<User | null>(null)
  const [reassignTo, setReassignTo] = useState<number | ''>('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [styleNotes, setStyleNotes] = useState(me.style_notes ?? '')
  const [saved, setSaved] = useState(false)
  const isAdmin = me.role === 'admin'

  const invite = async () => {
    setError('')
    try {
      await api('/users', { body: form })
      setInviting(false); setForm({ name: '', email: '', password: '', role: 'agent' }); refreshUsers()
    } catch (err) { setError(err instanceof Error ? err.message : '未能新增') }
  }

  const offboard = async () => {
    if (!offboarding || !reassignTo) return
    const r = await api<{ conversations: number; contacts: number; deals: number }>(`/users/${offboarding.id}/offboard`, { body: { reassignTo } })
    setResult(`已停用 ${offboarding.name}。${r.conversations} 個對話、${r.contacts} 位聯絡人、${r.deals} 宗跟進中交易已轉交，所有紀錄保留在公司。`)
    setOffboarding(null); setReassignTo(''); refreshUsers()
  }

  const saveStyle = async () => {
    setMe(await api<User>('/me', { method: 'PATCH', body: { style_notes: styleNotes } }))
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>團隊</h1>
          <p>同事離職時，對話、聯絡人與成交紀錄留在公司，一鍵轉交接手同事。</p>
        </div>
        {isAdmin && <button className="btn primary" onClick={() => setInviting(true)}><Icon name="plus" size={16} />新增同事</button>}
      </div>
      {result && <div className="demo-hint" style={{ marginBottom: 16 }}>{result}</div>}

      <div className="card" style={{ overflowX: 'auto', marginBottom: 22 }}>
        <table className="table">
          <thead><tr><th>同事</th><th>角色</th><th className="num">進行中對話</th><th className="num">負責客戶</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Avatar name={u.name} color={u.color} size={32} /><div><div style={{ fontWeight: 500 }}>{u.name}{u.id === me.id && <span className="faint">（我）</span>}</div><div className="faint" style={{ fontSize: 12 }}>{u.email}</div></div></div></td>
                <td>{u.active ? <span className={`chip ${u.role === 'admin' ? 'pine' : ''}`}>{u.role === 'admin' ? '管理員' : '同事'}</span> : <span className="chip">已離職</span>}</td>
                <td className="num">{u.open_conversations}</td>
                <td className="num">{u.owned_contacts}</td>
                <td style={{ textAlign: 'right' }}>
                  {isAdmin && u.active && u.id !== me.id ? <button className="btn sm danger" onClick={() => setOffboarding(u)}>離職交接</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card panel" style={{ maxWidth: 680 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkle" size={18} style={{ color: 'var(--iris)' }} />我的 AI 語氣</h2>
        <p className="sub">AI 會從你實際發出的回覆學習語氣。你亦可以補充說明自己的風格，例如常用語、稱呼、會否用 emoji。</p>
        <textarea className="textarea" value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)} placeholder="例如：廣東話為主，稱呼客人做「你」，句尾常用「呀」「喎」，間中用 😊" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button className="btn primary" onClick={saveStyle}>儲存</button>
          {saved && <span className="muted">已儲存</span>}
        </div>
      </div>

      {inviting && (
        <Modal title="新增同事" onClose={() => setInviting(false)}>
          <div><label className="label">名稱</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="label">電郵</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label className="label">臨時密碼（最少 8 個字元）</label><input className="input" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          <div><label className="label">角色</label>
            <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="agent">同事</option><option value="admin">管理員</option>
            </select></div>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions"><button className="btn" onClick={() => setInviting(false)}>取消</button><button className="btn primary" onClick={invite}>新增</button></div>
        </Modal>
      )}

      {offboarding && (
        <Modal title={`${offboarding.name} 離職交接`} onClose={() => setOffboarding(null)}>
          <p className="muted" style={{ margin: 0 }}>
            {offboarding.name} 的登入會即時停用。佢負責的 <b>{offboarding.open_conversations}</b> 個進行中對話、<b>{offboarding.owned_contacts}</b> 位客戶及跟進中交易會轉交給：
          </p>
          <select className="select" value={reassignTo} onChange={(e) => setReassignTo(e.target.value ? Number(e.target.value) : '')}>
            <option value="">選擇接手同事</option>
            {users.filter((u) => u.active && u.id !== offboarding.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <div className="demo-hint">所有訊息紀錄、聯絡人及成交紀錄都會保留在公司帳戶，不會刪除。</div>
          <div className="modal-actions"><button className="btn" onClick={() => setOffboarding(null)}>取消</button><button className="btn primary" disabled={!reassignTo} onClick={offboard}>確認交接</button></div>
        </Modal>
      )}
    </div>
  )
}
