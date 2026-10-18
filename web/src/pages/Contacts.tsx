import { useEffect, useState } from 'react'
import { api, type Contact } from '../api'
import { useApp } from '../App'
import { Avatar, Icon } from '../components'
import { formatPhone, money, timeLabel } from '../format'
import { getSocket } from '../socket'

export default function Contacts() {
  const { users } = useApp()
  const [q, setQ] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [draftName, setDraftName] = useState('')
  const [messageHits, setMessageHits] = useState<{ id: number; conversation_id: number; body: string; ts: number; contact_name: string; number_label: string }[]>([])

  const load = () => {
    api<Contact[]>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setContacts)
    if (q.trim()) api(`/search?q=${encodeURIComponent(q.trim())}`).then(setMessageHits)
    else setMessageHits([])
  }
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    const socket = getSocket()
    socket.on('contact', load)
    return () => { socket.off('contact', load) }
  }, [q])

  const openContact = async (c: Contact) => {
    const [latest] = await api<{ id: number }[]>(`/conversations?contactId=${c.id}`)
    if (latest) window.location.hash = `#/inbox/${latest.id}`
  }

  const saveName = async (c: Contact) => {
    await api(`/contacts/${c.id}`, { method: 'PATCH', body: { name: draftName.trim() || null } })
    setEditing(null)
    load()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>公司聯絡簿</h1>
          <p>客戶名稱與號碼只有一個共同來源，所有已連接的號碼與同事共用。改一次，處處更新。</p>
        </div>
        <div className="search" style={{ width: 320 }}>
          <Icon name="search" size={16} />
          <input className="input" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }} placeholder="搜尋聯絡人或訊息內容" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {messageHits.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', fontWeight: 500 }}>
            <Icon name="archive" size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />備份訊息中找到 {messageHits.length} 項
          </div>
          {messageHits.slice(0, 8).map((h) => (
            <a key={h.id} href={`#/inbox/${h.conversation_id}`} style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line-2)', color: 'inherit', textDecoration: 'none' }}>
              <b style={{ width: 160, flexShrink: 0, fontWeight: 500 }}>{h.contact_name}</b>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.body}</span>
              <span className="number-tag">{h.number_label}</span>
              <span className="faint" style={{ fontSize: 12, width: 48, textAlign: 'right' }}>{timeLabel(h.ts)}</span>
            </a>
          ))}
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr><th>客戶</th><th>電話</th><th>聯絡過的號碼</th><th>負責同事</th><th className="num">已成交</th><th>最近聯絡</th></tr>
          </thead>
          <tbody>
            {contacts.map((c) => {
              const owner = users.find((u) => u.id === c.owner_id)
              return (
                <tr key={c.id} className="clickable" onClick={() => editing !== c.id && openContact(c)}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={c.display_name ?? c.phone} size={32} />
                      {editing === c.id ? (
                        <input className="input" autoFocus value={draftName} onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDraftName(e.target.value)} onBlur={() => saveName(c)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveName(c); if (e.key === 'Escape') setEditing(null) }} style={{ maxWidth: 220 }} />
                      ) : (
                        <div>
                          <div style={{ fontWeight: 500 }}>
                            {c.display_name}
                            <button className="btn ghost sm" style={{ padding: '0 6px', marginLeft: 4, fontSize: 12 }}
                              onClick={(e) => { e.stopPropagation(); setEditing(c.id); setDraftName(c.name ?? c.wa_name ?? '') }}>改名</button>
                          </div>
                          {c.notes && <div className="faint" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.notes}</div>}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="num muted">{formatPhone(c.phone)}</td>
                  <td>{c.numbers?.split(',').map((n) => <span key={n} className="number-tag" style={{ marginRight: 4 }}>{n}</span>)}</td>
                  <td>{owner ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Avatar name={owner.name} color={owner.color} size={20} />{owner.name}{!owner.active && <span className="chip">已離職</span>}</span> : <span className="faint">—</span>}</td>
                  <td className="num">{c.won_amount ? money(c.won_amount) : <span className="faint">—</span>}</td>
                  <td className="muted">{c.last_message_at ? timeLabel(c.last_message_at) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {contacts.length === 0 && <div className="empty" style={{ height: 160 }}>未有聯絡人。連接號碼後，客戶會自動加入。</div>}
      </div>
    </div>
  )
}
