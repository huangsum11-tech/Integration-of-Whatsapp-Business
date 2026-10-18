import { useEffect, useState } from 'react'
import { api } from '../api'
import { Avatar } from '../components'
import { duration, formatPhone, money } from '../format'

interface Data {
  days: number
  totals: { sent: number; received: number; medianResponse: number | null; conversations: number; dealsWon: number; dealsWonAmount: number }
  daily: { day: string; sent: number; received: number }[]
  users: { id: number; name: string; color: string; active: number; sent: number; conversations: number; medianResponse: number | null; dealsWon: number; dealsWonAmount: number; dealsOpen: number }[]
  numbers: { id: number; label: string; phone: string | null; status: string; sent: number; received: number; conversations: number; medianResponse: number | null }[]
}

const RANGES = [7, 30, 90]

function Speed({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <span className="faint">—</span>
  return <span className={seconds <= 600 ? 'speed-good' : seconds > 3600 ? 'speed-slow' : ''}>{duration(seconds)}</span>
}

export default function Analytics() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Data | null>(null)
  useEffect(() => { api<Data>(`/analytics?days=${days}`).then(setData) }, [days])
  if (!data) return null
  const maxSent = Math.max(1, ...data.users.map((u) => u.sent))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>管理層分析</h1>
          <p>每個號碼、每位同事的回覆速度、活躍度與成交表現。</p>
        </div>
        <div className="tabs" style={{ width: 240 }}>
          {RANGES.map((r) => <button key={r} className={`tab ${days === r ? 'active' : ''}`} onClick={() => setDays(r)}>最近 {r} 日</button>)}
        </div>
      </div>

      <div className="kpis">
        <div className="card kpi"><div className="k-label">回覆速度（中位數）</div><div className="k-value"><Speed seconds={data.totals.medianResponse} /></div><div className="k-sub">由客戶發訊至團隊首次回覆</div></div>
        <div className="card kpi"><div className="k-label">活躍對話</div><div className="k-value">{data.totals.conversations}</div><div className="k-sub">期內有訊息往來</div></div>
        <div className="card kpi"><div className="k-label">訊息（收 ／ 發）</div><div className="k-value">{data.totals.received} <span className="faint" style={{ fontSize: 20 }}>/</span> {data.totals.sent}</div><div className="k-sub">全部號碼合計</div></div>
        <div className="card kpi"><div className="k-label">成交</div><div className="k-value">{money(data.totals.dealsWonAmount)}</div><div className="k-sub">{data.totals.dealsWon} 宗交易</div></div>
      </div>

      <div className="card panel" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div><h2>每日訊息量</h2><div className="sub">收到與發出的訊息</div></div>
          <div className="legend"><span><i style={{ background: 'var(--chart-received)' }} />收到</span><span><i style={{ background: 'var(--chart-sent)' }} />發出</span></div>
        </div>
        <DailyChart daily={data.daily} />
      </div>

      <div className="grid-2">
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="panel" style={{ paddingBottom: 4 }}><h2>同事表現</h2></div>
          <table className="table">
            <thead><tr><th>同事</th><th>發出訊息</th><th>回覆速度</th><th className="num">成交</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}><Avatar name={u.name} color={u.color} size={26} />{u.name}{!u.active && <span className="chip">已離職</span>}</div></td>
                  <td><div className="bar-cell"><div className="bar-track"><div className="bar-fill" style={{ width: `${(u.sent / maxSent) * 100}%` }} /></div><span className="num" style={{ width: 28, textAlign: 'right' }}>{u.sent}</span></div></td>
                  <td><Speed seconds={u.medianResponse} /></td>
                  <td className="num">{u.dealsWon ? money(u.dealsWonAmount) : <span className="faint">—</span>}<div className="faint" style={{ fontSize: 11 }}>{u.dealsWon} 成交 · {u.dealsOpen} 跟進中</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="panel" style={{ paddingBottom: 4 }}><h2>號碼表現</h2></div>
          <table className="table">
            <thead><tr><th>號碼</th><th className="num">對話</th><th className="num">收 ／ 發</th><th>回覆速度</th></tr></thead>
            <tbody>
              {data.numbers.map((n) => (
                <tr key={n.id}>
                  <td><div style={{ fontWeight: 500 }}>{n.label}</div><div className="faint" style={{ fontSize: 12 }}>{formatPhone(n.phone)}</div></td>
                  <td className="num">{n.conversations}</td>
                  <td className="num">{n.received} / {n.sent}</td>
                  <td><Speed seconds={n.medianResponse} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function DailyChart({ daily }: { daily: Data['daily'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 900, H = 200, padL = 32, padB = 22, padT = 8
  const max = Math.max(4, ...daily.map((d) => Math.max(d.sent, d.received)))
  const step = Math.ceil(max / 4)
  const top = step * 4
  const slot = (W - padL) / daily.length
  const barW = Math.max(2, Math.min(14, slot / 2 - 2))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top)
  const labelEvery = Math.ceil(daily.length / 10)
  const roundedBar = (x: number, v: number, color: string) => {
    if (!v) return null
    const yy = y(v), h = H - padB - yy, r = Math.min(4, barW / 2, h)
    return <path d={`M${x},${H - padB} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${H - padB} Z`} fill={color} />
  }
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="每日收到與發出訊息數量">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={y(step * i)} y2={y(step * i)} stroke="var(--line-2)" />
            <text x={padL - 8} y={y(step * i) + 4} textAnchor="end" fontSize="11" fill="var(--faint)">{step * i}</text>
          </g>
        ))}
        {daily.map((d, i) => {
          const cx = padL + slot * i + slot / 2
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={cx - slot / 2} y={padT} width={slot} height={H - padT - padB} fill={hover === i ? 'rgba(18,32,28,.04)' : 'transparent'} />
              {roundedBar(cx - barW - 1, d.received, 'var(--chart-received)')}
              {roundedBar(cx + 1, d.sent, 'var(--chart-sent)')}
              {i % labelEvery === 0 && <text x={cx} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--faint)">{d.day.slice(5).replace('-', '/')}</text>}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%`, top: `${(y(Math.max(daily[hover].sent, daily[hover].received)) / H) * 100}%` }}>
          <b>{daily[hover].day.slice(5).replace('-', '/')}</b> · 收到 {daily[hover].received} · 發出 {daily[hover].sent}
        </div>
      )}
    </div>
  )
}
