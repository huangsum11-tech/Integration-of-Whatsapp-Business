/**
 * Things that run on a clock, checked every minute:
 * - trial follow-up: a message to the customer a set time after their first trial class,
 * - "customer waiting" alerts: a WhatsApp to the teammate (or the manager) when a customer
 *   has been waiting too long for a person to reply.
 * Notifications to the team are sent from the number chosen in settings.
 */
import { normalizePhone, sendReply, sendToPhone } from './channels.js'
import { CONTACT_NAME_SQL, all, get, getSetting, run, setSetting, tx } from './db.js'
import { addEvent, getConversation } from './inbox.js'
import { broadcast } from './realtime.js'
import { formatLocal, localParts } from './time.js'

export const DEFAULT_FOLLOWUP = `{名稱} 你好！今日試堂感覺點呀？😊
有冇咩問題想問？如果想繼續上堂，我可以介紹啱你嘅套票同時間表。`

export function automationSettings() {
  return {
    notify_number_id: Number(getSetting('notify_number_id')) || null,
    followup_enabled: getSetting('followup_enabled', '1') === '1',
    followup_minutes: Number(getSetting('followup_minutes', '120')),
    followup_message: getSetting('followup_message', DEFAULT_FOLLOWUP),
    followup_wa_template_name: getSetting('followup_wa_template_name'),
    followup_wa_template_language: getSetting('followup_wa_template_language', 'zh_HK'),
    alert_enabled: getSetting('alert_enabled', '1') === '1',
    alert_minutes: Number(getSetting('alert_minutes', '15')),
    alert_phone: getSetting('alert_phone'),
    alert_from_hour: Number(getSetting('alert_from_hour', '9')),
    alert_to_hour: Number(getSetting('alert_to_hour', '22')),
  }
}

export type AutomationSettings = ReturnType<typeof automationSettings>

export function saveAutomationSettings(s: Partial<AutomationSettings>) {
  tx(() => {
    for (const [key, value] of Object.entries(s)) {
      if (value === undefined) continue
      setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : value === null ? '' : String(value))
    }
  })
}

// ---------- Trials ----------

export function trialsForContact(contactId: number) {
  return all('SELECT * FROM trials WHERE contact_id = ? ORDER BY class_at DESC', contactId)
}

export function upcomingTrials() {
  return all(
    `SELECT t.*, ${CONTACT_NAME_SQL} AS contact_name, c.id AS conversation_id
     FROM trials t JOIN contacts ct ON ct.id = t.contact_id
     LEFT JOIN conversations c ON c.id = t.conversation_id
     WHERE t.class_at > unixepoch() - 14 * 86400 ORDER BY t.class_at DESC LIMIT 200`,
  )
}

/** Record a trial; the same customer at the same time is recorded once. */
export function recordTrial(conversationId: number, at: number, className: string, source: 'ai' | 'staff', userId: number | null) {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('找不到對話')
  const existing = get<{ id: number }>("SELECT id FROM trials WHERE contact_id = ? AND class_at = ? AND status = 'booked'", conversation.contact_id, at)
  if (existing) return existing.id
  const id = Number(run(
    'INSERT INTO trials (contact_id, conversation_id, class_at, class_name, source, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    conversation.contact_id, conversationId, at, className, source, userId,
  ).lastInsertRowid)
  addEvent(conversationId, userId, 'trial', `${formatLocal(at)} ${className}`.trim())
  broadcast('trial', { contactId: conversation.contact_id })
  return id
}

function renderFor(template: string, contactName: string, className: string) {
  return template.replaceAll('{名稱}', contactName).replaceAll('{課堂}', className || '試堂')
}

/** Send the follow-up for one trial. Outside the 24-hour window, Cloud API numbers need a template. */
async function sendFollowup(trial: { id: number; conversation_id: number | null; class_name: string }) {
  const s = automationSettings()
  const conversation = trial.conversation_id ? getConversation(trial.conversation_id) : undefined
  if (!conversation) throw new Error('找不到對話')
  const firstName = String(conversation.contact_name).split(/[\s(（]/)[0]
  const text = renderFor(s.followup_message, firstName, trial.class_name)
  try {
    await sendReply(conversation.id, text, { userId: null, aiAuto: true })
  } catch (err) {
    const outsideWindow = conversation.channel === 'wa_cloud' && err instanceof Error && err.message.includes('24 小時')
    if (!outsideWindow || !s.followup_wa_template_name || !conversation.phone) throw err
    await sendToPhone(conversation.number_id, conversation.phone, text, {
      userId: null,
      template: { name: s.followup_wa_template_name, language: s.followup_wa_template_language, params: [firstName] },
    })
  }
  // The customer's answer should get a fresh reply from the AI, not wait in a paused conversation.
  run('UPDATE conversations SET ai_paused = 0 WHERE id = ?', conversation.id)
}

async function followUps() {
  const s = automationSettings()
  if (!s.followup_enabled) return
  const due = all<{ id: number; conversation_id: number | null; class_name: string }>(
    `SELECT id, conversation_id, class_name FROM trials
     WHERE status = 'booked' AND followup_status = 'pending'
       AND class_at + ? * 60 <= unixepoch() AND class_at > unixepoch() - 2 * 86400`,
    s.followup_minutes,
  )
  for (const trial of due) {
    try {
      await sendFollowup(trial)
      run("UPDATE trials SET followup_status = 'sent', followup_at = unixepoch(), followup_error = NULL WHERE id = ?", trial.id)
    } catch (err) {
      run("UPDATE trials SET followup_status = 'failed', followup_error = ? WHERE id = ?", err instanceof Error ? err.message : '發送失敗', trial.id)
      if (trial.conversation_id) addEvent(trial.conversation_id, null, 'ai_error', `試堂跟進發送失敗：${err instanceof Error ? err.message : ''}`)
    }
    broadcast('trial', {})
  }
}

// ---------- Customer waiting alerts ----------

/** Phones that belong to the team: chats with them are not customers waiting. */
function teamPhones(s: AutomationSettings) {
  const phones = all<{ phone: string }>("SELECT phone FROM users WHERE phone != ''").map((u) => normalizePhone(u.phone))
  if (s.alert_phone) phones.push(normalizePhone(s.alert_phone))
  return phones
}

export function waitingCustomers(minutes: number) {
  return all<{ id: number; contact_name: string; number_label: string; waited: number; assignee_id: number | null; phone: string | null }>(
    `SELECT c.id, ${CONTACT_NAME_SQL} AS contact_name, n.label AS number_label, c.assignee_id, ct.phone,
       (unixepoch() - last.ts) / 60 AS waited
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     JOIN numbers n ON n.id = c.number_id
     JOIN messages last ON last.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY ts DESC, id DESC LIMIT 1)
     WHERE c.status = 'open' AND last.from_me = 0
       AND last.ts <= unixepoch() - ? * 60 AND last.ts > unixepoch() - 86400
       AND (c.human_alert_at IS NULL OR c.human_alert_at < last.ts)
       -- The AI is still handling it: not waiting for a person.
       AND NOT (n.reply_mode = 'auto' AND c.ai_paused = 0 AND c.needs_human = 0)`,
    minutes,
  )
}

async function waitingAlerts() {
  const s = automationSettings()
  if (!s.alert_enabled || !s.notify_number_id) return
  const hour = localParts().hour
  if (hour < s.alert_from_hour || hour >= s.alert_to_hour) return
  const team = new Set(teamPhones(s))
  const waiting = waitingCustomers(s.alert_minutes).filter((c) => !c.phone || !team.has(c.phone))
  if (waiting.length === 0) return

  // Each waiting customer goes to their assigned teammate's phone, otherwise to the manager's.
  const byPhone = new Map<string, typeof waiting>()
  for (const c of waiting) {
    const assigneePhone = c.assignee_id ? get<{ phone: string }>('SELECT phone FROM users WHERE id = ? AND active = 1', c.assignee_id)?.phone : ''
    const to = assigneePhone || s.alert_phone
    if (!to) continue
    byPhone.set(to, [...(byPhone.get(to) ?? []), c])
  }
  for (const [phone, list] of byPhone) {
    const lines = list.slice(0, 10).map((c) => `• ${c.contact_name}（${c.number_label}，等咗 ${c.waited} 分鐘）`)
    const more = list.length > 10 ? `\n…另外 ${list.length - 10} 位` : ''
    const text = `【Baton】有 ${list.length} 位客人等緊回覆：\n${lines.join('\n')}${more}\n請打開 Baton 收件匣回覆。`
    try {
      await sendToPhone(s.notify_number_id, phone, text, { userId: null })
    } catch (err) {
      console.error('Waiting alert failed', err)
    }
    // Marked even if sending failed, so a broken setting doesn't retry every minute.
    for (const c of list) run('UPDATE conversations SET human_alert_at = unixepoch() WHERE id = ?', c.id)
  }
}

export function startAutomation() {
  setInterval(() => {
    followUps().catch((err) => console.error('Trial follow-ups failed', err))
    waitingAlerts().catch((err) => console.error('Waiting alerts failed', err))
  }, 60_000)
}
