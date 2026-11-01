import { useCallback, useEffect, useState } from 'react'
import { CHANNEL_LABEL, api, type Channel } from '../api'
import { useApp } from '../App'
import { Avatar, Icon, type IconName } from '../components'
import { getSocket } from '../socket'
import Analytics from './Analytics'

interface Need {
  id: number; contact_name: string; channel: Channel; number_label: string; needs_human: number; assignee_id: number | null
  waiting_since: number; last_body: string; last_type: string; handoff_reason: string | null
}
interface Item { at: number; kind: 'trial' | 'followup' | 'broadcast' | 'payroll' | 'report'; title: string; detail: string; done: boolean; link: string }
interface Home {
  now: number; needs: Need[]; timeline: Item[]
  today: { received: number; aiReplies: number; teamReplies: number; handoffs: number; newCustomers: number }
  channels: { id: number; label: string; channel: Channel; status: string; reply_mode: string; demo: number; lastEvent: number | null }[]
  setup: { done: number; total: number; next: { label: string; detail: string; page: string } | null } | null
}

export const CHANNEL_ICON: Record<Channel, IconName> = { wa_web: 'phone', wa_cloud: 'phone', instagram: 'instagram', messenger: 'facebook', threads: 'threads' }
const KIND_ICON: Record<Item['kind'], IconName> = { trial: 'user', followup: 'sparkle', broadcast: 'megaphone', payroll: 'wallet', report: 'chart' }
const MEDIA: Record<string, string> = { image: '📷 相片', video: '🎬 影片', voice: '🎤 語音', audio: '🎵 音訊', document: '📄 文件', sticker: '貼圖', location: '📍 位置' }
const MODE: Record<string, string> = { off: '人手回覆', suggest: 'AI 建議', auto: 'AI 全自動' }

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
function waited(ts: number, now: number) {
  const m = Math.max(0, Math.round((now - ts) / 60))
  return m < 60 ? `等咗 ${m} 分鐘` : m < 1440 ? `等咗 ${Math.floor(m / 60)} 小時` : `等咗 ${Math.floor(m / 1440)} 日`
}

export default function Today({ tab }: { tab: 'today' | 'analytics' }) {
  return (
    <div className="area">
      <div className="area-tabs" role="tablist" aria-label="今日">
        <a role="tab" aria-selected={tab === 'today'} className={`area-tab ${tab === 'today' ? 'active' : ''}`} href="#/today">今日</a>
        <a role="tab" aria-selected={tab === 'analytics'} className={`area-tab ${tab === 'analytics' ? 'active' : ''}`} href="#/today/analytics">數據分析</a>
      </div>
      <div className="area-body">{tab === 'analytics' ? <Analytics /> : <Overview />}</div>
    </div>
  )
}

function Overview() {
  const { me, users } = useApp()
  const [home, setHome] = useState<Home | null>(null)
  const load = useCallback(() => { api<Home>('/home').then(setHome) }, [])
  useEffect(() => {
    load()
    const socket = getSocket()
    const events = ['conversation', 'trial', 'campaign', 'payroll', 'number']
    for (const e of events) socket.on(e, load)
    const tick = setInterval(load, 60_000)
    return () => { for (const e of events) socket.off(e, load); clearInterval(tick) }
  }, [load])
  if (!home) return null

  const date = new Date(home.now * 1000)
  const t = home.today
  const replies = t.aiReplies + t.teamReplies
  const nowIndex = home.timeline.findIndex((i) => i.at > home.now)
  const mine = home.needs.filter((n) => n.assignee_id === me.id).length

  return (
    <div className="page today">
      <header className="today-head">
        <div>
          <h1 className="today-date">
            {date.getMonth() + 1}月{date.getDate()}日
            <span>{date.toLocaleDateString('zh-HK', { weekday: 'long' })}</span>
          </h1>
          <p className="today-line">
            今日收到 <b>{t.received}</b> 條客人訊息，新客人 <b>{t.newCustomers}</b> 位；
            AI 回覆了 <b>{t.aiReplies}</b> 條{replies ? `（${Math.round((t.aiReplies / replies) * 100)}%）` : ''}，轉交同事 <b>{t.handoffs}</b> 次。
          </p>
        </div>
        <ChannelStrip channels={home.channels} />
      </header>

      {home.setup && home.setup.next && (
        <a className="setup-nudge" href={`#/${home.setup.next.page}`}>
          <span className="setup-meter" aria-hidden="true"><span style={{ width: `${(home.setup.done / home.setup.total) * 100}%` }} /></span>
          <span>設定完成 {home.setup.done}／{home.setup.total}。下一步：<b>{home.setup.next.label}</b>，{home.setup.next.detail}</span>
        </a>
      )}

      <div className="today-grid">
        <section className="needs" aria-labelledby="needs-title">
          <div className="section-head">
            <h2 id="needs-title">需要你處理</h2>
            {home.needs.length > 0 && <span className="muted">{home.needs.length} 位客人{mine ? `，其中 ${mine} 位由你負責` : ''}</span>}
          </div>
          {home.needs.length === 0 ? (
            <div className="needs-empty">
              <Icon name="check" size={22} />
              <div><b>沒有客人在等。</b><br /><span className="muted">AI 處理不到的對話會出現在這裏。</span></div>
            </div>
          ) : (
            <ul className="needs-list">
              {home.needs.map((n) => {
                const assignee = users.find((u) => u.id === n.assignee_id)
                return (
                  <li key={n.id}>
                    <a href={`#/inbox/${n.id}`} className={`need ${n.needs_human ? 'handoff' : ''}`}>
                      <span className="avatar-wrap">
                        <Avatar name={n.contact_name} size={38} />
                        <span className="channel-badge" title={CHANNEL_LABEL[n.channel]}><Icon name={CHANNEL_ICON[n.channel]} size={11} /></span>
                      </span>
                      <span className="need-main">
                        <b>{n.contact_name}</b>
                        <span className="need-why">
                          {n.needs_human && n.handoff_reason ? `AI 轉交：${n.handoff_reason}` : n.last_body || MEDIA[n.last_type] || '新訊息'}
                        </span>
                      </span>
                      <span className="need-meta">
                        <span className="need-wait">{waited(n.waiting_since, home.now)}</span>
                        <span className="faint">{assignee ? assignee.name.split(' ')[0] : '未分配'}</span>
                      </span>
                    </a>
                  </li>
                )
              })}
            </ul>
          )}
          <a className="see-all" href="#/inbox">打開收件匣</a>
        </section>

        <section className="timeline" aria-labelledby="timeline-title">
          <div className="section-head"><h2 id="timeline-title">今日時間表</h2></div>
          {home.timeline.length === 0 ? (
            <p className="muted timeline-empty">今日未有試堂、自動跟進或排程發送。客人告訴 AI 試堂時間後，會自動排進這裏。</p>
          ) : (
            <ol className="slots">
              {home.timeline.map((item, i) => (
                <li key={`${item.kind}-${item.at}-${i}`} className="slot-wrap">
                  {i === nowIndex && <NowLine now={home.now} />}
                  <a className={`slot ${item.done ? 'done' : ''} kind-${item.kind}`} href={item.link}>
                    <time>{hhmm(item.at)}</time>
                    <span className="slot-mark" aria-hidden="true" />
                    <span className="slot-body">
                      <b><Icon name={KIND_ICON[item.kind]} size={14} />{item.title}</b>
                      <span className="muted">{item.detail}</span>
                    </span>
                  </a>
                </li>
              ))}
              {nowIndex === -1 && <li className="slot-wrap"><NowLine now={home.now} /></li>}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}

function NowLine({ now }: { now: number }) {
  return <div className="now-line" role="separator" aria-label={`現在 ${hhmm(now)}`}><time>{hhmm(now)}</time><span>現在</span></div>
}

function ChannelStrip({ channels }: { channels: Home['channels'] }) {
  const real = channels.filter((c) => !c.demo)
  const shown = real.length ? real : channels
  if (shown.length === 0) return <a className="channel-strip empty" href="#/settings/channels">未連接任何渠道：前往連接</a>
  return (
    <ul className="channel-strip" aria-label="渠道狀態">
      {shown.map((c) => {
        const ok = c.status === 'connected' || c.status === 'demo'
        return (
          <li key={c.id}>
            <a href="#/settings/channels" title={`${c.label}：${ok ? '已連接' : '未連接'}，${MODE[c.reply_mode]}`}>
              <Icon name={CHANNEL_ICON[c.channel]} size={15} />
              <span className="ch-name">{c.label}</span>
              <span className={`ch-state ${ok ? 'ok' : 'down'}`}>{ok ? MODE[c.reply_mode] : '未連接'}</span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
