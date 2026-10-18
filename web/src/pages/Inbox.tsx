import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, type Contact, type Conversation, type Deal, type InboxEvent, type Message } from '../api'
import { useApp } from '../App'
import { Avatar, Icon, Modal } from '../components'
import { clock, dayLabel, formatPhone, money, timeLabel } from '../format'
import { getSocket } from '../socket'

type View = 'all' | 'mine' | 'unassigned' | 'closed'
const VIEWS: { id: View; label: string }[] = [
  { id: 'mine', label: '我的' },
  { id: 'unassigned', label: '未分配' },
  { id: 'all', label: '全部' },
  { id: 'closed', label: '已完成' },
]

interface Detail {
  conversation: Conversation
  contact: Contact
  deals: Deal[]
  otherConversations: { id: number; last_message_at: number; last_preview: string; number_label: string }[]
  timeline: (Message | InboxEvent)[]
  canSend: boolean
}

export default function Inbox({ conversationId }: { conversationId: number | null }) {
  const { users } = useApp()
  const [view, setView] = useState<View>('all')
  const [numberId, setNumberId] = useState<number | ''>('')
  const [q, setQ] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [counts, setCounts] = useState<Record<View, number>>({ all: 0, mine: 0, unassigned: 0, closed: 0 })
  const [detail, setDetail] = useState<Detail | null>(null)
  const { numbers } = useApp()

  const loadList = useCallback(() => {
    const params = new URLSearchParams({ view })
    if (numberId) params.set('numberId', String(numberId))
    if (q) params.set('q', q)
    api<Conversation[]>(`/conversations?${params}`).then(setConversations)
    api<Record<View, number>>('/conversations/counts').then(setCounts)
  }, [view, numberId, q])

  const loadDetail = useCallback((id: number) => {
    api<Detail>(`/conversations/${id}`).then(setDetail).catch(() => setDetail(null))
  }, [])

  useEffect(() => { const t = setTimeout(loadList, q ? 200 : 0); return () => clearTimeout(t) }, [loadList, q])

  useEffect(() => {
    if (!conversationId) { setDetail(null); return }
    loadDetail(conversationId)
    api(`/conversations/${conversationId}/read`, { method: 'POST' })
  }, [conversationId, loadDetail])

  // Live updates: every teammate sees new messages, handoffs and notes as they happen.
  useEffect(() => {
    const socket = getSocket()
    const onMessage = (m: Message) => {
      if (m.conversation_id !== conversationId) return
      setDetail((d) => d && !d.timeline.some((t) => t.item === 'message' && t.id === m.id)
        ? { ...d, timeline: [...d.timeline, { ...m, item: 'message' }] } : d)
      api(`/conversations/${conversationId}/read`, { method: 'POST' })
    }
    const onEvent = (e: InboxEvent) => {
      if (e.conversation_id !== conversationId) return
      setDetail((d) => d && !d.timeline.some((t) => t.item === 'event' && t.id === e.id) ? { ...d, timeline: [...d.timeline, e] } : d)
    }
    const onConversation = (c: Conversation) => {
      loadList()
      if (c.id === conversationId) setDetail((d) => (d ? { ...d, conversation: c } : d))
    }
    const reloadActive = () => { loadList(); if (conversationId) loadDetail(conversationId) }
    socket.on('message', onMessage)
    socket.on('event', onEvent)
    socket.on('conversation', onConversation)
    socket.on('contact', reloadActive)
    socket.on('media', reloadActive)
    socket.on('sync', loadList)
    socket.on('refresh', reloadActive)
    return () => {
      socket.off('message', onMessage); socket.off('event', onEvent); socket.off('conversation', onConversation)
      socket.off('contact', reloadActive); socket.off('media', reloadActive); socket.off('sync', loadList); socket.off('refresh', reloadActive)
    }
  }, [conversationId, loadList, loadDetail])

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])

  return (
    <div className={`inbox ${conversationId ? 'has-active' : ''}`}>
      <section className="list-pane" aria-label="對話列表">
        <div className="list-head">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2>收件匣</h2>
            <select className="select" style={{ width: 'auto', padding: '4px 8px', fontSize: 13 }} value={numberId}
              onChange={(e) => setNumberId(e.target.value ? Number(e.target.value) : '')} aria-label="篩選號碼">
              <option value="">所有號碼</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </div>
          <div className="tabs" role="tablist">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={`tab ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)}>
                {v.label}<span className="count">{counts[v.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="search">
            <Icon name="search" size={16} />
            <input className="input" placeholder="搜尋客戶名稱或電話" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="conv-list">
          {conversations.length === 0 && <div className="empty" style={{ height: 200 }}>這裏暫時沒有對話</div>}
          {conversations.map((c) => {
            const assignee = c.assignee_id ? userById.get(c.assignee_id) : undefined
            return (
              <button key={c.id} className={`conv ${c.id === conversationId ? 'active' : ''} ${c.unread ? 'unread' : ''}`}
                onClick={() => { window.location.hash = `#/inbox/${c.id}` }}>
                <Avatar name={c.contact_name} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div className="name">{c.contact_name}</div>
                  <div className="preview">{c.last_preview || ' '}</div>
                  <div className="tags">
                    <span className="number-tag">{c.number_label}</span>
                    {assignee
                      ? <span className="faint" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Avatar name={assignee.name} color={assignee.color} size={14} />{assignee.name.split(' ')[0]}
                        </span>
                      : <span className="chip coral" style={{ fontSize: 11, padding: '0 7px' }}>未分配</span>}
                  </div>
                </div>
                <div className="meta">
                  {c.last_message_at ? timeLabel(c.last_message_at) : ''}
                  {c.unread > 0 && <span className="badge">{c.unread}</span>}
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {detail && conversationId ? (
        <>
          <Thread key={detail.conversation.id} detail={detail} />
          <SidePanel detail={detail} reload={() => loadDetail(detail.conversation.id)} />
        </>
      ) : (
        <section className="thread">
          <div className="empty">
            <div>
              <Icon name="inbox" size={40} />
              <p>選擇一個對話開始回覆。<br />所有號碼的客戶訊息都集中在這裏。</p>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function Thread({ detail }: { detail: Detail }) {
  const { me, users } = useApp()
  const { conversation, timeline, canSend } = detail
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [text, setText] = useState('')
  const [aiDraft, setAiDraft] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }) }, [timeline.length])

  const assignee = users.find((u) => u.id === conversation.assignee_id)

  const draft = async () => {
    setDrafting(true); setError('')
    try {
      const { draft } = await api<{ draft: string }>(`/conversations/${conversation.id}/draft`, { body: { instruction: instruction || undefined } })
      setText(draft); setAiDraft(true); setMode('reply')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 草擬失敗')
    } finally {
      setDrafting(false)
    }
  }

  const send = async () => {
    if (!text.trim()) return
    setSending(true); setError('')
    try {
      if (mode === 'note') await api(`/conversations/${conversation.id}/notes`, { body: { body: text.trim() } })
      else await api(`/conversations/${conversation.id}/messages`, { body: { text: text.trim(), aiAssisted: aiDraft } })
      setText(''); setAiDraft(false); setInstruction('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '發送失敗')
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  const toggleStatus = () =>
    api(`/conversations/${conversation.id}`, { method: 'PATCH', body: { status: conversation.status === 'open' ? 'closed' : 'open' } })

  let lastDay = ''
  return (
    <section className="thread" aria-label="對話">
      <header className="thread-head">
        <a href="#/inbox" className="btn ghost sm back-btn" aria-label="返回"><Icon name="back" /></a>
        <Avatar name={conversation.contact_name} size={40} />
        <div className="who">
          <b>{conversation.contact_name}</b>
          <div className="muted" style={{ fontSize: 12 }}>{formatPhone(conversation.phone)} · 經 <b style={{ fontWeight: 500 }}>{conversation.number_label}</b></div>
        </div>
        <button className="btn sm" onClick={() => setHandoffOpen(true)}>
          {assignee ? <Avatar name={assignee.name} color={assignee.color} size={18} /> : <Icon name="user" size={16} />}
          <span className="btn-label">{assignee ? assignee.name.split(' ')[0] : '分配'}</span>
          <Icon name="handoff" size={14} />
        </button>
        <button className={`btn sm ${conversation.status === 'open' ? 'primary' : ''}`} onClick={toggleStatus}>
          <Icon name={conversation.status === 'open' ? 'check' : 'inbox'} size={15} />
          <span className="btn-label">{conversation.status === 'open' ? '完成' : '重新開啟'}</span>
        </button>
      </header>

      <div className="thread-body" ref={bodyRef}>
        {timeline.map((item) => {
          const day = dayLabel(item.ts)
          const sep = day !== lastDay ? <div className="day-sep">{day}</div> : null
          lastDay = day
          return (
            <Fragment key={`${item.item}-${item.id}`}>
              {sep}
              {item.item === 'message' ? <Bubble m={item} /> : <EventLine e={item} />}
            </Fragment>
          )
        })}
      </div>

      <div className={`composer ${mode === 'note' ? 'noting' : ''}`}>
        <div className="composer-modes">
          <button className={`mode ${mode === 'reply' ? 'active' : ''}`} onClick={() => setMode('reply')}>回覆客戶</button>
          <button className={`mode note-mode ${mode === 'note' ? 'active' : ''}`} onClick={() => setMode('note')}>內部備註</button>
        </div>
        {aiDraft && mode === 'reply' && (
          <div className="draft-banner">
            <Icon name="sparkle" size={14} />
            AI 已按 {me.name.split(' ')[0]} 的語氣草擬，發送前可自由修改
            <button className="btn ghost sm" style={{ marginLeft: 'auto', padding: '0 6px' }} onClick={() => { setText(''); setAiDraft(false) }} aria-label="捨棄草稿"><Icon name="x" size={14} /></button>
          </div>
        )}
        <div className="composer-box">
          <textarea className="textarea" rows={2} value={text} onKeyDown={onKey}
            placeholder={mode === 'note' ? '寫下只有同事看到的備註…' : canSend ? '輸入訊息，Enter 發送，Shift+Enter 換行' : '此號碼未連接，暫時不能發送'}
            disabled={mode === 'reply' && !canSend}
            onChange={(e) => setText(e.target.value)} />
          <button className="btn primary" onClick={send} disabled={sending || !text.trim() || (mode === 'reply' && !canSend)} aria-label="發送" style={{ height: 44 }}>
            <Icon name={mode === 'note' ? 'note' : 'send'} size={17} />
          </button>
        </div>
        {mode === 'reply' && (
          <div className="composer-actions">
            <input className="input ai-instruction" placeholder="給 AI 的提示（可選），例如：提醒佢星期六送貨" value={instruction}
              onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && draft()} />
            <button className="btn ai sm" onClick={draft} disabled={drafting}>
              <Icon name="sparkle" size={15} />{drafting ? '草擬中…' : 'AI 草擬'}
            </button>
          </div>
        )}
        {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
      </div>
      {handoffOpen && <HandoffModal conversation={conversation} onClose={() => setHandoffOpen(false)} />}
    </section>
  )
}

function Bubble({ m }: { m: Message }) {
  const media = m.media_path ? `/media/${m.media_path}` : null
  const mediaEl = (() => {
    if (m.type === 'image' || m.type === 'sticker') return media ? <img src={media} alt="" loading="lazy" /> : <div className="media-missing">📷 相片</div>
    if (m.type === 'video') return media ? <video src={media} controls preload="metadata" /> : <div className="media-missing">🎬 影片</div>
    if (m.type === 'audio' || m.type === 'voice') return media ? <audio src={media} controls preload="metadata" /> : <div className="media-missing">{m.type === 'voice' ? '🎤 語音訊息' : '🎵 音訊'}</div>
    if (m.type === 'document') return media
      ? <a href={media} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="file" size={16} />{m.body || '文件'}</a>
      : <div className="media-missing">📄 {m.body || '文件'}</div>
    if (m.type === 'location') return <div>📍 {m.body}</div>
    if (m.type === 'contact') return <div>👤 {m.body}</div>
    if (m.type === 'other') return <div className="media-missing">（不支援的訊息類型）</div>
    return null
  })()
  const showBody = m.body && !['document', 'location', 'contact'].includes(m.type)
  return (
    <div className={`bubble-row ${m.from_me ? 'out' : 'in'}`}>
      <div className={`bubble ${m.ai_assisted ? 'ai' : ''}`}>
        {mediaEl}
        {showBody && m.body}
      </div>
      <div className="bubble-meta">
        {m.from_me ? <span>{m.sender_name ?? '由手機發送'}</span> : null}
        {m.ai_assisted ? <span className="chip iris" style={{ fontSize: 10, padding: '0 6px' }}><Icon name="sparkle" size={10} />AI 草擬</span> : null}
        <span>{clock(m.ts)}</span>
      </div>
    </div>
  )
}

function EventLine({ e }: { e: InboxEvent }) {
  const who = e.user_name?.split(' ')[0] ?? '系統'
  const target = e.target_name?.split(' ')[0] ?? ''
  if (e.kind === 'note') {
    return (
      <div className="note">
        <div className="note-head">內部備註 · {who} · {clock(e.ts)}</div>
        {e.body}
      </div>
    )
  }
  const text: Record<string, string> = {
    assign: `${who} 將對話分配給 ${target}`,
    handoff: `${who} 將對話交接給 ${target}`,
    unassign: `${who} 取消了分配`,
    close: `${who} 標記為完成`,
    reopen: `${who} 重新開啟對話`,
    offboard: `同事離職，對話已轉交 ${target}`,
    deal_won: `${who} 成交：${e.body}`,
    deal_lost: `${who} 標記失單：${e.body}`,
  }
  return (
    <div className={`event ${e.kind === 'handoff' || e.kind === 'offboard' ? 'handoff' : ''}`}>
      <Icon name={e.kind.startsWith('deal') ? 'trophy' : e.kind === 'close' ? 'check' : 'handoff'} size={13} />
      <span>{text[e.kind] ?? e.kind}{e.body && !e.kind.startsWith('deal') ? `：「${e.body}」` : ''} · {clock(e.ts)}</span>
    </div>
  )
}

function HandoffModal({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { users, me } = useApp()
  const [userId, setUserId] = useState<number | null>(conversation.assignee_id ?? me.id)
  const [note, setNote] = useState('')
  const active = users.filter((u) => u.active)
  const save = async () => {
    await api(`/conversations/${conversation.id}/assign`, { body: { userId, note } })
    onClose()
  }
  return (
    <Modal title={conversation.assignee_id ? '交接對話' : '分配對話'} onClose={onClose}>
      <div>
        <label className="label">交給</label>
        <div style={{ display: 'grid', gap: 6 }}>
          {active.map((u) => (
            <label key={u.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', borderColor: userId === u.id ? 'var(--pine)' : undefined, background: userId === u.id ? 'var(--pine-50)' : undefined }}>
              <input type="radio" name="assignee" checked={userId === u.id} onChange={() => setUserId(u.id)} />
              <Avatar name={u.name} color={u.color} size={26} />
              <span style={{ flex: 1 }}>{u.name}{u.id === me.id && <span className="faint">（我）</span>}</span>
              <span className="faint" style={{ fontSize: 12 }}>{u.open_conversations ?? 0} 個進行中</span>
            </label>
          ))}
          <label className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}>
            <input type="radio" name="assignee" checked={userId === null} onChange={() => setUserId(null)} />
            <span className="muted">放回未分配</span>
          </label>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="handoff-note">交接備註（同事會在對話中看到）</label>
        <textarea id="handoff-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：客人想要黑色，已報價 $3,280，等佢確認送貨日期" />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save}><Icon name="handoff" size={15} />確認</button>
      </div>
    </Modal>
  )
}

function SidePanel({ detail, reload }: { detail: Detail; reload: () => void }) {
  const { users } = useApp()
  const { contact, deals, otherConversations, conversation } = detail
  const [name, setName] = useState(contact.name ?? '')
  const [notes, setNotes] = useState(contact.notes)
  const [dealTitle, setDealTitle] = useState('')
  const [dealAmount, setDealAmount] = useState('')

  useEffect(() => { setName(contact.name ?? ''); setNotes(contact.notes) }, [contact.id, contact.name, contact.notes])

  const saveContact = (patch: Partial<Contact>) => api(`/contacts/${contact.id}`, { method: 'PATCH', body: patch }).then(reload)
  const addDeal = async () => {
    if (!dealTitle.trim()) return
    await api('/deals', { body: { contact_id: contact.id, conversation_id: conversation.id, title: dealTitle.trim(), amount: Number(dealAmount) || 0 } })
    setDealTitle(''); setDealAmount(''); reload()
  }
  const setStage = (id: number, stage: Deal['stage']) => api(`/deals/${id}`, { method: 'PATCH', body: { stage } }).then(reload)

  return (
    <aside className="side-pane" aria-label="客戶資料">
      <div className="contact-hero">
        <Avatar name={contact.name || contact.wa_name || contact.phone} size={64} />
        <input className="input" style={{ textAlign: 'center', fontWeight: 700, fontSize: 16, border: '1px solid transparent' }}
          value={name} placeholder={contact.wa_name ?? '加入名稱'} onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (contact.name ?? '') && saveContact({ name: name || null })} aria-label="客戶名稱" />
        <span className="muted">{formatPhone(contact.phone)}</span>
        {contact.wa_name && contact.wa_name !== contact.name && <span className="faint" style={{ fontSize: 12 }}>WhatsApp 名稱：{contact.wa_name}</span>}
      </div>

      <div className="side-section">
        <h3>公司聯絡簿</h3>
        <dl className="kv">
          <dt>負責同事</dt>
          <dd>
            <select className="select" style={{ padding: '3px 6px' }} value={contact.owner_id ?? ''}
              onChange={(e) => saveContact({ owner_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">未指定</option>
              {users.filter((u) => u.active || u.id === contact.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </dd>
          <dt>其他號碼</dt>
          <dd>
            {otherConversations.length === 0 ? <span className="faint">只經此號碼聯絡</span> : otherConversations.map((o) => (
              <a key={o.id} href={`#/inbox/${o.id}`} style={{ display: 'block' }}>{o.number_label}</a>
            ))}
          </dd>
        </dl>
        <label className="label" style={{ marginTop: 12 }} htmlFor="contact-notes">備註</label>
        <textarea id="contact-notes" className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== contact.notes && saveContact({ notes })} placeholder="喜好、地址、注意事項…全公司共用" />
      </div>

      <div className="side-section">
        <h3>成交紀錄</h3>
        {deals.length === 0 && <div className="faint" style={{ fontSize: 13 }}>未有紀錄</div>}
        {deals.map((d) => (
          <div className="deal" key={d.id}>
            <div className="title">
              <div>{d.title}</div>
              <div className="faint" style={{ fontSize: 12 }}>{money(d.amount)} · {d.user_name?.split(' ')[0]}</div>
            </div>
            {d.stage === 'open' ? (
              <>
                <button className="btn sm" title="成交" onClick={() => setStage(d.id, 'won')}><Icon name="check" size={14} /></button>
                <button className="btn sm" title="失單" onClick={() => setStage(d.id, 'lost')}><Icon name="x" size={14} /></button>
              </>
            ) : (
              <span className={`chip ${d.stage === 'won' ? 'pine' : ''}`}>{d.stage === 'won' ? '已成交' : '失單'}</span>
            )}
          </div>
        ))}
        <div className="inline-form">
          <input className="input" placeholder="新交易" value={dealTitle} onChange={(e) => setDealTitle(e.target.value)} style={{ flex: 2 }} />
          <input className="input" placeholder="金額" inputMode="decimal" value={dealAmount} onChange={(e) => setDealAmount(e.target.value)} style={{ flex: 1 }} />
          <button className="btn sm" onClick={addDeal} aria-label="新增交易"><Icon name="plus" size={15} /></button>
        </div>
      </div>
    </aside>
  )
}
