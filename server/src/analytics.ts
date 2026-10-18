import { all } from './db.js'

interface Msg { conversation_id: number; from_me: number; sender_id: number | null; ts: number; number_id: number; assignee_id: number | null }

interface Bucket { sent: number; received: number; responseTimes: number[]; conversations: Set<number> }

const bucket = (): Bucket => ({ sent: 0, received: 0, responseTimes: [], conversations: new Set() })

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Reply speed = time from the first unanswered customer message to the team's next reply.
 * The reply is credited to whoever sent it from Baton, or to the conversation's assignee
 * when it was typed on the phone itself.
 */
export function teamAnalytics(days: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const messages = all<Msg>(
    `SELECT m.conversation_id, m.from_me, m.sender_id, m.ts, c.number_id, c.assignee_id
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.ts >= ? ORDER BY m.conversation_id, m.ts`,
    since,
  )

  const byUser = new Map<number, Bucket>()
  const byNumber = new Map<number, Bucket>()
  const daily = new Map<string, { sent: number; received: number }>()
  const allTimes: number[] = []

  let waitingSince: number | null = null
  let currentConversation = -1
  for (const m of messages) {
    if (m.conversation_id !== currentConversation) {
      currentConversation = m.conversation_id
      waitingSince = null
    }
    const day = new Date(m.ts * 1000).toISOString().slice(0, 10)
    const d = daily.get(day) ?? { sent: 0, received: 0 }
    daily.set(day, d)
    const numberStats = byNumber.get(m.number_id) ?? bucket()
    byNumber.set(m.number_id, numberStats)
    numberStats.conversations.add(m.conversation_id)

    if (!m.from_me) {
      d.received++
      numberStats.received++
      waitingSince ??= m.ts
      continue
    }
    d.sent++
    numberStats.sent++
    const credited = m.sender_id ?? m.assignee_id
    const userStats = credited ? byUser.get(credited) ?? bucket() : undefined
    if (credited && userStats) {
      byUser.set(credited, userStats)
      userStats.sent++
      userStats.conversations.add(m.conversation_id)
    }
    if (waitingSince !== null) {
      const wait = m.ts - waitingSince
      allTimes.push(wait)
      numberStats.responseTimes.push(wait)
      userStats?.responseTimes.push(wait)
      waitingSince = null
    }
  }

  const deals = all<{ user_id: number; won: number; won_amount: number; open: number }>(
    `SELECT user_id,
            SUM(stage = 'won') AS won,
            COALESCE(SUM(CASE WHEN stage = 'won' THEN amount END), 0) AS won_amount,
            SUM(stage = 'open') AS open
     FROM deals WHERE created_at >= ? OR closed_at >= ? GROUP BY user_id`,
    since, since,
  )
  const dealsByUser = new Map(deals.map((d) => [d.user_id, d]))

  const users = all<{ id: number; name: string; color: string; active: number }>(
    'SELECT id, name, color, active FROM users ORDER BY active DESC, name',
  )
  const numbers = all<{ id: number; label: string; phone: string | null; status: string }>(
    'SELECT id, label, phone, status FROM numbers ORDER BY id',
  )

  const dayList: { day: string; sent: number; received: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    dayList.push({ day, ...(daily.get(day) ?? { sent: 0, received: 0 }) })
  }

  const totalWon = deals.reduce((s, d) => s + d.won, 0)
  const totalWonAmount = deals.reduce((s, d) => s + d.won_amount, 0)

  return {
    days,
    totals: {
      sent: dayList.reduce((s, d) => s + d.sent, 0),
      received: dayList.reduce((s, d) => s + d.received, 0),
      medianResponse: median(allTimes),
      conversations: new Set(messages.map((m) => m.conversation_id)).size,
      dealsWon: totalWon,
      dealsWonAmount: totalWonAmount,
    },
    daily: dayList,
    users: users.map((u) => {
      const s = byUser.get(u.id) ?? bucket()
      const d = dealsByUser.get(u.id)
      return {
        id: u.id, name: u.name, color: u.color, active: u.active,
        sent: s.sent, conversations: s.conversations.size, medianResponse: median(s.responseTimes),
        dealsWon: d?.won ?? 0, dealsWonAmount: d?.won_amount ?? 0, dealsOpen: d?.open ?? 0,
      }
    }),
    numbers: numbers.map((n) => {
      const s = byNumber.get(n.id) ?? bucket()
      return {
        id: n.id, label: n.label, phone: n.phone, status: n.status,
        sent: s.sent, received: s.received, conversations: s.conversations.size,
        medianResponse: median(s.responseTimes),
      }
    }),
  }
}
