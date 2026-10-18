export function formatPhone(phone: string | null | undefined) {
  if (!phone) return ''
  if (!/^\d+$/.test(phone)) return phone
  if (phone.startsWith('852') && phone.length === 11) return `+852 ${phone.slice(3, 7)} ${phone.slice(7)}`
  return `+${phone}`
}

export function timeLabel(ts: number) {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const yesterday = new Date(now.getTime() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return '昨日'
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString('zh-HK', { weekday: 'short' })
  return d.toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric' })
}

export function clock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function dayLabel(ts: number) {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今日'
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨日'
  return d.toLocaleDateString('zh-HK', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export function duration(seconds: number | null) {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小時`
  return `${(seconds / 86400).toFixed(1)} 日`
}

export function money(amount: number) {
  return `HK$${Math.round(amount).toLocaleString('en-HK')}`
}

export function initials(name: string) {
  const latin = name.match(/[A-Za-z]+/g)
  if (latin) return latin.slice(0, 2).map((w) => w[0].toUpperCase()).join('')
  return [...name.replace(/\s/g, '')].slice(0, 1).join('')
}

const AVATAR_COLORS = ['#0e7c66', '#d9573c', '#6c5ce7', '#b07d12', '#2f6fd6', '#b23c6e', '#3d8a63', '#7a5b3d']
export function colorFor(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
