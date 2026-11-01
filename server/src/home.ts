/**
 * The 今日 (Today) page: what needs a person now, what happens today on the studio's
 * timeline (trials, automatic follow-ups, scheduled broadcasts and payslips), today's AI
 * numbers, and whether each channel is connected.
 */
import { automationSettings } from './automation.js'
import { CONTACT_NAME_SQL, all, get, getSetting } from './db.js'
import { setupStatus } from './setup.js'
import { localParts, parseLocal } from './time.js'

type Kind = 'trial' | 'followup' | 'broadcast' | 'payroll' | 'report'
interface TimelineItem { at: number; kind: Kind; title: string; detail: string; done: boolean; link: string }

function dayBounds() {
  const p = localParts()
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = parseLocal(`${p.year}-${pad(p.month)}-${pad(p.day)} 00:00`)!
  return { start, end: start + 86400 }
}

export function homeData(userId: number, admin: boolean) {
  const { start, end } = dayBounds()
  const now = Math.floor(Date.now() / 1000)
  const followupAfter = automationSettings().followup_minutes * 60
  const hidePrivate = admin ? '' : "AND ct.phone NOT IN (SELECT phone FROM instructors WHERE phone != '')"

  // Customers waiting for a person: handed off by the AI, or not answered by anyone.
  const needs = all(
    `SELECT c.id, ${CONTACT_NAME_SQL} AS contact_name, n.channel, n.label AS number_label, c.needs_human, c.assignee_id,
       last.ts AS waiting_since, last.body AS last_body, last.type AS last_type,
       (SELECT body FROM events e WHERE e.conversation_id = c.id AND e.kind = 'ai_handoff' ORDER BY e.ts DESC LIMIT 1) AS handoff_reason
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     JOIN numbers n ON n.id = c.number_id
     JOIN messages last ON last.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY ts DESC, id DESC LIMIT 1)
     WHERE c.status = 'open' AND (
       c.needs_human = 1
       OR (last.from_me = 0 AND last.ts > ? - 3 * 86400 AND NOT (n.reply_mode = 'auto' AND c.ai_paused = 0))
     )
       ${hidePrivate}
     ORDER BY c.needs_human DESC, (c.assignee_id = ?) DESC, last.ts ASC LIMIT 12`,
    now, userId,
  )

  const timeline: TimelineItem[] = []
  for (const t of all<{ class_at: number; class_name: string; contact_name: string; conversation_id: number | null; followup_status: string; status: string }>(
    `SELECT t.class_at, t.class_name, t.followup_status, t.status, t.conversation_id, ${CONTACT_NAME_SQL} AS contact_name
     FROM trials t JOIN contacts ct ON ct.id = t.contact_id
     WHERE t.status = 'booked' AND ((t.class_at >= ? AND t.class_at < ?) OR (t.class_at + ? >= ? AND t.class_at + ? < ?))`,
    start, end, followupAfter, start, followupAfter, end,
  )) {
    const link = t.conversation_id ? `#/inbox/${t.conversation_id}` : '#/customers/trials'
    if (t.class_at >= start && t.class_at < end) {
      timeline.push({ at: t.class_at, kind: 'trial', title: `試堂：${t.contact_name}`, detail: t.class_name || '試堂', done: t.class_at < now, link })
    }
    if (t.followup_status !== 'skipped') {
      timeline.push({
        at: t.class_at + followupAfter, kind: 'followup', title: `自動跟進：${t.contact_name}`,
        detail: t.followup_status === 'sent' ? '已發送' : t.followup_status === 'failed' ? '發送失敗，請查看對話' : '上堂後自動發送',
        done: t.followup_status === 'sent', link,
      })
    }
  }
  if (admin) {
    for (const c of all<{ id: number; name: string; at: number; status: string }>(
      `SELECT id, name, COALESCE(sent_at, scheduled_at) AS at, status FROM campaigns
       WHERE COALESCE(sent_at, scheduled_at) >= ? AND COALESCE(sent_at, scheduled_at) < ? AND status IN ('scheduled','sending','sent')`,
      start, end,
    )) {
      timeline.push({ at: c.at, kind: 'broadcast', title: `群發：${c.name}`, detail: c.status === 'sent' ? '已發送' : c.status === 'sending' ? '發送中' : '已排程', done: c.status === 'sent', link: '#/marketing' })
    }
    for (const r of all<{ month: string; at: number; status: string }>(
      `SELECT month, COALESCE(sent_at, scheduled_at) AS at, status FROM payroll_runs
       WHERE COALESCE(sent_at, scheduled_at) >= ? AND COALESCE(sent_at, scheduled_at) < ?`,
      start, end,
    )) {
      const [y, m] = r.month.split('-')
      timeline.push({ at: r.at, kind: 'payroll', title: `糧單：${y}年${Number(m)}月`, detail: r.status === 'sent' ? '已發送' : '已排程', done: r.status === 'sent', link: '#/instructors' })
    }
    const p = localParts()
    if (getSetting('report_enabled') === '1' && Number(getSetting('report_weekday', '1')) === p.weekday) {
      const at = start + Number(getSetting('report_hour', '9')) * 3600
      timeline.push({ at, kind: 'report', title: '每週報告', detail: '經 WhatsApp 發送', done: at < now, link: '#/settings/automation' })
    }
  }
  timeline.sort((a, b) => a.at - b.at)

  const count = (sql: string, ...params: unknown[]) => get<{ c: number }>(sql, ...params)?.c ?? 0
  const today = {
    received: count('SELECT COUNT(*) AS c FROM messages WHERE from_me = 0 AND ts >= ?', start),
    aiReplies: count('SELECT COUNT(*) AS c FROM messages WHERE ai_auto = 1 AND ts >= ?', start),
    teamReplies: count('SELECT COUNT(*) AS c FROM messages WHERE from_me = 1 AND ai_auto = 0 AND sender_id IS NOT NULL AND ts >= ?', start),
    handoffs: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'ai_handoff' AND ts >= ?", start),
    newCustomers: count('SELECT COUNT(*) AS c FROM conversations c WHERE (SELECT MIN(ts) FROM messages WHERE conversation_id = c.id) >= ?', start),
  }

  const channels = all<{ id: number; label: string; channel: string; status: string; reply_mode: string; demo: number }>(
    'SELECT id, label, channel, status, reply_mode, demo FROM numbers ORDER BY id',
  ).map((n) => {
    const object = ({ wa_cloud: 'whatsapp_business_account', instagram: 'instagram', messenger: 'page', threads: 'threads' } as Record<string, string>)[n.channel]
    return { ...n, lastEvent: object ? Number(getSetting(`webhook_last_${object}`)) || null : null }
  })

  const checks = admin ? setupStatus().filter((c) => !c.optional) : []
  return {
    now, needs, timeline, today, channels,
    setup: admin ? { done: checks.filter((c) => c.ok).length, total: checks.length, next: checks.find((c) => !c.ok) ?? null } : null,
  }
}
