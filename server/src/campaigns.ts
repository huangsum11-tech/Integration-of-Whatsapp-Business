/**
 * Broadcasts: one promotion or announcement to a group of customers on WhatsApp, sent one
 * by one. Groups come from built-in segments (trial customers, recent, inactive…) and tags.
 * Official Cloud API numbers send an approved marketing template; while a promotion runs,
 * its details are added to what the AI knows, so it can answer customers' replies.
 */
import { normalizePhone, sendToPhone } from './channels.js'
import { CONTACT_NAME_SQL, SOCIAL_SQL, all, get, run, tx } from './db.js'
import { parseCsv } from './knowledge.js'
import { broadcast } from './realtime.js'

export const SEGMENTS = {
  all: '全部客人',
  trial_no_deal: '上過試堂但未成交',
  trial: '所有試堂客人',
  active_30: '30 日內有對話',
  inactive_60: '超過 60 日沒有對話',
  new_30: '30 日內新客人',
} as const
export type Segment = keyof typeof SEGMENTS
export interface Audience { segment: Segment; tags: string[] }

/** Messages one by one with a gap, so WhatsApp doesn't treat the burst as spam. */
const GAP_MS = Number(process.env.BATON_BROADCAST_GAP_MS ?? 10_000)

const SEGMENT_SQL: Record<Segment, string> = {
  all: '1',
  trial: "EXISTS (SELECT 1 FROM trials t WHERE t.contact_id = ct.id AND t.status = 'booked')",
  trial_no_deal: `EXISTS (SELECT 1 FROM trials t WHERE t.contact_id = ct.id AND t.status = 'booked' AND t.class_at < unixepoch())
    AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = ct.id AND d.stage = 'won')`,
  active_30: 'last_at > unixepoch() - 30 * 86400',
  inactive_60: 'last_at <= unixepoch() - 60 * 86400',
  new_30: 'ct.created_at > unixepoch() - 30 * 86400',
}

/** Customers in the audience who can get a WhatsApp: a real phone number, not a teammate or instructor. */
export function audienceContacts(a: Audience) {
  const tags = a.tags.filter(Boolean)
  return all<{ id: number; name: string; phone: string }>(
    `SELECT * FROM (
       SELECT ct.id, ${CONTACT_NAME_SQL} AS name, ct.phone, ct.created_at,
         (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.contact_id = ct.id) AS last_at
       FROM contacts ct
       WHERE (${SOCIAL_SQL}) IS NULL AND (ct.lid IS NULL OR ct.phone != ct.lid)
         AND ct.phone NOT IN (SELECT phone FROM instructors WHERE phone != '')
         AND ct.phone NOT IN (SELECT phone FROM users WHERE phone != '')
     ) ct
     WHERE ${SEGMENT_SQL[a.segment] ?? '1'}
       ${tags.length ? `AND EXISTS (SELECT 1 FROM contact_tags g WHERE g.contact_id = ct.id AND g.tag IN (${tags.map(() => '?').join(',')}))` : ''}
     ORDER BY ct.id`,
    ...tags,
  )
}

export function allTags() {
  return all<{ tag: string; count: number }>('SELECT tag, COUNT(*) AS count FROM contact_tags GROUP BY tag ORDER BY count DESC, tag')
}

export function setTags(contactId: number, tags: string[]) {
  tx(() => {
    run('DELETE FROM contact_tags WHERE contact_id = ?', contactId)
    for (const tag of new Set(tags.map((t) => t.trim()).filter(Boolean))) {
      run('INSERT INTO contact_tags (contact_id, tag) VALUES (?, ?)', contactId, tag)
    }
  })
}

export function tagsFor(contactId: number) {
  return all<{ tag: string }>('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag', contactId).map((t) => t.tag)
}

/**
 * Add customers from a spreadsheet (e.g. a Vibefam member export): columns for name, phone
 * and optional tags (separated by commas). Existing customers get the tags added.
 */
export function importContacts(csv: string, extraTag = '') {
  const rows = parseCsv(csv)
  if (rows.length < 2) throw new Error('檔案最少要有標題列和一行資料')
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const find = (re: RegExp) => header.findIndex((h) => re.test(h))
  const pi = find(/電話|手機|phone|mobile|whatsapp|tel/)
  if (pi < 0) throw new Error('找不到電話欄（欄名要包含「電話」或 phone）')
  const ni = find(/姓名|名稱|name/)
  const ti = find(/標籤|tag/)
  let added = 0
  let updated = 0
  tx(() => {
    for (const r of rows.slice(1)) {
      const phone = normalizePhone(r[pi] ?? '')
      if (phone.length < 8) continue
      const name = ni >= 0 ? (r[ni] ?? '').trim() : ''
      let contact = get<{ id: number }>('SELECT id FROM contacts WHERE phone = ?', phone)
      if (contact) {
        updated++
        if (name) run('UPDATE contacts SET saved_name = COALESCE(saved_name, ?) WHERE id = ?', name, contact.id)
      } else {
        contact = { id: Number(run('INSERT INTO contacts (phone, saved_name) VALUES (?, ?)', phone, name || null).lastInsertRowid) }
        added++
      }
      const tags = [...(ti >= 0 ? (r[ti] ?? '').split(/[,，、]/) : []), extraTag].map((t) => t.trim()).filter(Boolean)
      for (const tag of tags) run('INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)', contact.id, tag)
    }
  })
  return { added, updated }
}

// ---------- Campaigns ----------

export function listCampaigns() {
  return all(
    `SELECT c.*, n.label AS number_label, n.channel, u.name AS created_by_name,
       (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) AS total,
       (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent
     FROM campaigns c LEFT JOIN numbers n ON n.id = c.number_id LEFT JOIN users u ON u.id = c.created_by
     ORDER BY c.created_at DESC LIMIT 50`,
  )
}

export function getCampaign(id: number) {
  const campaign = get<Record<string, any>>(
    'SELECT c.*, n.label AS number_label, n.channel FROM campaigns c LEFT JOIN numbers n ON n.id = c.number_id WHERE c.id = ?', id,
  )
  if (!campaign) return undefined
  const recipients = all(
    `SELECT r.id, r.contact_id, r.status, r.error, r.sent_at, r.delivered_at, r.read_at,
       ${CONTACT_NAME_SQL} AS name, ct.phone,
       -- A reply: the customer wrote within 7 days after the broadcast.
       EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
               WHERE cv.contact_id = r.contact_id AND m.from_me = 0 AND m.ts > r.sent_at AND m.ts < r.sent_at + 7 * 86400) AS replied,
       (SELECT cv.id FROM conversations cv WHERE cv.contact_id = r.contact_id AND cv.number_id = ? LIMIT 1) AS conversation_id
     FROM campaign_recipients r JOIN contacts ct ON ct.id = r.contact_id
     WHERE r.campaign_id = ? ORDER BY r.status DESC, name`,
    campaign.number_id, id,
  )
  const count = (f: (r: any) => boolean) => recipients.filter(f).length
  return {
    ...campaign,
    audience: JSON.parse(campaign.audience || '{}'),
    recipients,
    stats: {
      total: recipients.length, sent: count((r) => r.status === 'sent'), failed: count((r) => r.status === 'failed'),
      delivered: count((r) => r.delivered_at), read: count((r) => r.read_at), replied: count((r) => r.replied),
    },
  }
}

export interface CampaignInput {
  name: string; number_id: number | null; audience: Audience; message: string
  wa_template_name: string; wa_template_language: string; wa_template_params: string
  ai_note: string; ai_until: number | null
}

export function saveCampaign(input: CampaignInput, userId: number, id?: number) {
  const values = [
    input.name, input.number_id, JSON.stringify(input.audience), input.message,
    input.wa_template_name, input.wa_template_language, input.wa_template_params, input.ai_note, input.ai_until,
  ]
  if (id) {
    const current = get<{ status: string }>('SELECT status FROM campaigns WHERE id = ?', id)
    if (!current) throw new Error('找不到群發')
    if (current.status !== 'draft') throw new Error('已排程或已發送的群發不能修改，請先取消排程')
    run(`UPDATE campaigns SET name = ?, number_id = ?, audience = ?, message = ?, wa_template_name = ?,
           wa_template_language = ?, wa_template_params = ?, ai_note = ?, ai_until = ? WHERE id = ?`, ...values, id)
    return id
  }
  return Number(run(`INSERT INTO campaigns (name, number_id, audience, message, wa_template_name, wa_template_language,
    wa_template_params, ai_note, ai_until, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values, userId).lastInsertRowid)
}

/** Promotions the AI should know about right now. */
export function activePromotions() {
  return all<{ name: string; ai_note: string }>(
    `SELECT name, ai_note FROM campaigns
     WHERE ai_note != '' AND status IN ('scheduled','sending','sent') AND (ai_until IS NULL OR ai_until > unixepoch())`,
  )
}

function personalise(text: string, name: string) {
  return text.replaceAll('{名稱}', name.split(/[\s(（]/)[0])
}

async function sendOne(campaign: Record<string, any>, contact: { name: string; phone: string }, userId: number | null) {
  const params = String(campaign.wa_template_params).split(/[,，]/).map((p) => p.trim()).filter(Boolean)
    .map((p) => (p === '名稱' ? contact.name.split(/[\s(（]/)[0] : p))
  return sendToPhone(campaign.number_id, contact.phone, personalise(campaign.message, contact.name), {
    userId,
    template: campaign.wa_template_name
      ? { name: campaign.wa_template_name, language: campaign.wa_template_language, params }
      : undefined,
  })
}

/** Send one copy to a teammate's phone first, to check how it looks. */
export async function sendTest(id: number, phone: string, userId: number) {
  const campaign = get<Record<string, any>>('SELECT * FROM campaigns WHERE id = ?', id)
  if (!campaign?.number_id) throw new Error('請先選擇發送號碼')
  await sendOne(campaign, { name: '測試', phone: normalizePhone(phone) }, userId)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sending = new Set<number>()

export async function sendCampaign(id: number) {
  if (sending.has(id)) return
  const campaign = get<Record<string, any>>('SELECT * FROM campaigns WHERE id = ?', id)
  if (!campaign) return
  if (!campaign.number_id) throw new Error('請先選擇發送號碼')
  if (!String(campaign.message).trim()) throw new Error('請先填寫訊息內容')
  sending.add(id)
  // The audience is fixed when sending starts; customers added later are not included.
  tx(() => {
    for (const c of audienceContacts(JSON.parse(campaign.audience))) {
      run('INSERT OR IGNORE INTO campaign_recipients (campaign_id, contact_id) VALUES (?, ?)', id, c.id)
    }
    run("UPDATE campaigns SET status = 'sending' WHERE id = ?", id)
  })
  broadcast('campaign', { id })
  try {
    const pending = all<{ id: number; name: string; phone: string }>(
      `SELECT r.id, ${CONTACT_NAME_SQL} AS name, ct.phone FROM campaign_recipients r JOIN contacts ct ON ct.id = r.contact_id
       WHERE r.campaign_id = ? AND r.status IN ('pending','failed')`,
      id,
    )
    for (const [i, r] of pending.entries()) {
      try {
        const waId = await sendOne(campaign, r, campaign.created_by)
        run("UPDATE campaign_recipients SET status = 'sent', error = NULL, wa_id = ?, sent_at = unixepoch() WHERE id = ?", waId ?? null, r.id)
      } catch (err) {
        run("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?", err instanceof Error ? err.message : '發送失敗', r.id)
      }
      broadcast('campaign', { id })
      // Vary the gap a little: a perfectly regular rhythm looks automated.
      if (i < pending.length - 1) await sleep(GAP_MS * (0.7 + Math.random() * 0.6))
    }
  } finally {
    sending.delete(id)
    run("UPDATE campaigns SET status = 'sent', sent_at = unixepoch(), scheduled_at = NULL WHERE id = ?", id)
    broadcast('campaign', { id })
  }
}

export function startCampaignScheduler() {
  setInterval(() => {
    for (const due of all<{ id: number }>("SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= unixepoch()")) {
      sendCampaign(due.id).catch((err) => console.error('Scheduled broadcast failed', err))
    }
  }, 60_000)
}
