/**
 * Weekly summary for the owner on WhatsApp: enquiries, how much the AI handled, handoffs,
 * reply speed, trials, sales, broadcasts and Instagram comments over the last 7 days.
 */
import { teamAnalytics } from './analytics.js'
import { automationSettings } from './automation.js'
import { normalizePhone, sendToPhone } from './channels.js'
import { get, getSetting, setSetting, tx } from './db.js'
import { localParts } from './time.js'

export function reportSettings() {
  return {
    report_enabled: getSetting('report_enabled', '0') === '1',
    report_phones: getSetting('report_phones'),
    report_weekday: Number(getSetting('report_weekday', '1')),
    report_hour: Number(getSetting('report_hour', '9')),
  }
}

export function saveReportSettings(s: Partial<ReturnType<typeof reportSettings>>) {
  tx(() => {
    for (const [key, value] of Object.entries(s)) {
      if (value !== undefined) setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    }
  })
}

const count = (sql: string, ...params: unknown[]) => get<{ c: number }>(sql, ...params)?.c ?? 0

function duration(seconds: number | null) {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘`
  return `${(seconds / 3600).toFixed(1)} 小時`
}

export function weeklyReport(): string {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400
  const a = teamAnalytics(7)
  const newChats = count('SELECT COUNT(*) AS c FROM conversations c WHERE (SELECT MIN(ts) FROM messages WHERE conversation_id = c.id) >= ?', since)
  const aiReplies = count('SELECT COUNT(*) AS c FROM messages WHERE ai_auto = 1 AND ts >= ?', since)
  const teamReplies = count('SELECT COUNT(*) AS c FROM messages WHERE from_me = 1 AND ai_auto = 0 AND ts >= ?', since)
  const handoffs = count("SELECT COUNT(*) AS c FROM events WHERE kind = 'ai_handoff' AND ts >= ?", since)
  const trialsBooked = count("SELECT COUNT(*) AS c FROM trials WHERE created_at >= ? AND status = 'booked'", since)
  const trialsTaken = count("SELECT COUNT(*) AS c FROM trials WHERE class_at >= ? AND class_at < unixepoch() AND status = 'booked'", since)
  const followUps = count("SELECT COUNT(*) AS c FROM trials WHERE followup_at >= ? AND followup_status = 'sent'", since)
  const broadcastSent = count("SELECT COUNT(*) AS c FROM campaign_recipients WHERE sent_at >= ? AND status = 'sent'", since)
  const igDms = count("SELECT COUNT(*) AS c FROM ig_comments WHERE created_at >= ? AND status = 'sent'", since)
  const waiting = count(
    `SELECT COUNT(*) AS c FROM conversations c
     WHERE c.status = 'open' AND (SELECT from_me FROM messages WHERE conversation_id = c.id ORDER BY ts DESC, id DESC LIMIT 1) = 0
       AND (c.needs_human = 1 OR c.ai_paused = 1)`,
  )
  const aiShare = aiReplies + teamReplies ? Math.round((aiReplies / (aiReplies + teamReplies)) * 100) : 0
  const name = getSetting('business_name')

  return [
    `📊 ${name ? `${name} ` : ''}每週報告（過去 7 日）`,
    '',
    `💬 查詢：新客人對話 ${newChats} 個，客人訊息 ${a.totals.received} 條`,
    `🤖 AI 自動回覆 ${aiReplies} 條（佔所有回覆 ${aiShare}%），轉交同事 ${handoffs} 次`,
    `⏱ 同事回覆速度（中位數）：${duration(a.totals.medianResponse)}`,
    `🧘 試堂：新預約 ${trialsBooked} 位，已上堂 ${trialsTaken} 位，已跟進 ${followUps} 位`,
    `💰 成交：${a.totals.dealsWon} 宗，共 $${a.totals.dealsWonAmount.toLocaleString('en-US')}`,
    broadcastSent || igDms ? `📣 推廣：群發 ${broadcastSent} 條，IG 留言自動私訊 ${igDms} 次` : null,
    waiting ? `⚠️ 現在仍有 ${waiting} 位客人等緊同事回覆` : '✅ 現在沒有客人等緊回覆',
  ].filter((l) => l !== null).join('\n')
}

export async function sendWeeklyReport() {
  const s = reportSettings()
  const numberId = automationSettings().notify_number_id
  if (!numberId) throw new Error('請先在「自動化」選擇通知用號碼')
  const phones = s.report_phones.split(/[,，;、\n]+/).map(normalizePhone).filter((p) => p.length >= 8)
  if (phones.length === 0) throw new Error('請先填寫收報告的 WhatsApp 號碼')
  const text = weeklyReport()
  for (const phone of phones) await sendToPhone(numberId, phone, text, { userId: null })
  return phones.length
}

/** Called every minute; sends once in the chosen weekday hour. */
export async function reportTick() {
  const s = reportSettings()
  if (!s.report_enabled) return
  const now = localParts()
  const key = `${now.year}-${now.month}-${now.day}`
  if (now.weekday !== s.report_weekday || now.hour < s.report_hour || getSetting('report_sent') === key) return
  setSetting('report_sent', key)
  await sendWeeklyReport()
}
