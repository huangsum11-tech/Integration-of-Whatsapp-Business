/**
 * Monthly instructor payslips. Vibefam has no public API, so the month's payroll report is
 * exported from Vibefam as CSV and uploaded here. Baton groups it by instructor, fills a
 * message template, and sends each instructor their payslip on WhatsApp (now or at a set
 * time). On the last day of each month it reminds the admin on WhatsApp to upload the report.
 */
import { normalizePhone, sendToPhone } from './channels.js'
import { all, get, getSetting, run, setSetting, tx } from './db.js'
import { parseCsv } from './knowledge.js'
import { broadcast } from './realtime.js'

export const TIME_ZONE = process.env.BATON_TZ ?? 'Asia/Hong_Kong'
/** Pause between payslips, so a burst of messages doesn't look like spam to WhatsApp. */
const SEND_GAP_MS = Number(process.env.BATON_PAYROLL_GAP_MS ?? 3000)

export const DEFAULT_TEMPLATE = `{導師} 你好！以下是 {月份} 的糧單：
上堂數目：{堂數}
金額：\${金額}

明細：
{明細}

如有問題請回覆此訊息，多謝！`

export function payrollSettings() {
  return {
    number_id: Number(getSetting('payroll_number_id')) || null,
    template: getSetting('payroll_template', DEFAULT_TEMPLATE),
    wa_template_name: getSetting('payroll_wa_template_name'),
    wa_template_language: getSetting('payroll_wa_template_language', 'zh_HK'),
    wa_template_params: getSetting('payroll_wa_template_params', '導師,月份,堂數,金額'),
    reminder_phone: getSetting('payroll_reminder_phone'),
    reminder_hour: Number(getSetting('payroll_reminder_hour', '10')),
  }
}

export type PayrollSettings = ReturnType<typeof payrollSettings>

export function savePayrollSettings(s: Partial<PayrollSettings>) {
  tx(() => {
    for (const [key, value] of Object.entries(s)) {
      if (value !== undefined) setSetting(`payroll_${key}`, value === null ? '' : String(value))
    }
  })
}

// ---------- Reading the report ----------

const GUESS = {
  name: /導師|老師|教練|instructor|teacher|trainer|coach|staff|姓名|名稱|name/i,
  amount: /總額|總數|合計|金額|薪|糧|total|amount|pay|earning|salary|fee|commission/i,
  count: /堂數|課數|節數|classes|sessions|count|堂/i,
}

/** Column headers, the data rows, and a best guess at which columns matter. */
export function analyzeReport(csv: string) {
  const rows = parseCsv(csv)
  if (rows.length < 2) throw new Error('報表最少要有標題列和一行資料')
  const columns = rows[0].map((c, i) => c.trim() || `欄 ${i + 1}`)
  const pick = (re: RegExp, except: (string | undefined)[] = []) => columns.find((c) => re.test(c) && !except.includes(c))
  const name = pick(GUESS.name)
  // Prefer a "total" column for the amount when there are several money columns.
  const amount = columns.find((c) => /總額|合計|total/i.test(c) && c !== name) ?? pick(GUESS.amount, [name])
  const count = pick(GUESS.count, [name, amount])
  return { columns, rows: rows.slice(1), guess: { name, amount, count } }
}

function toNumber(value: string | undefined) {
  const n = Number((value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function money(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })
}

export function monthLabel(month: string) {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

export function render(template: string, fields: Record<string, string>) {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => fields[key.trim()] ?? whole)
}

export interface RunInput {
  month: string
  csv: string
  nameColumn: string
  amountColumn?: string
  countColumn?: string
  userId: number
}

/**
 * Group the report by instructor. A report with one row per class gives 堂數 = number of rows;
 * a report with one row per instructor can name the column that already holds the count.
 */
export function createRun(input: RunInput) {
  const { columns, rows } = analyzeReport(input.csv)
  const col = (name?: string) => (name ? columns.indexOf(name) : -1)
  const [ni, ai, ci] = [col(input.nameColumn), col(input.amountColumn), col(input.countColumn)]
  if (ni < 0) throw new Error('請選擇導師名稱欄')

  const groups = new Map<string, string[][]>()
  for (const r of rows) {
    const name = (r[ni] ?? '').trim()
    if (!name || /^(總計|合計|total)$/i.test(name)) continue
    groups.set(name, [...(groups.get(name) ?? []), r])
  }
  if (groups.size === 0) throw new Error('報表內找不到導師名稱')

  const template = payrollSettings().template
  return tx(() => {
    const runId = Number(run('INSERT INTO payroll_runs (month, created_by) VALUES (?, ?)', input.month, input.userId).lastInsertRowid)
    for (const [name, list] of groups) {
      const fields: Record<string, string> = {}
      // Every report column is available as {column name}; repeated values are listed once.
      columns.forEach((c, i) => { fields[c] = [...new Set(list.map((r) => (r[i] ?? '').trim()).filter(Boolean))].join('、') })
      fields['導師'] = name
      fields['月份'] = monthLabel(input.month)
      fields['堂數'] = String(ci >= 0 ? list.reduce((sum, r) => sum + toNumber(r[ci]), 0) : list.length)
      fields['金額'] = ai >= 0 ? money(list.reduce((sum, r) => sum + toNumber(r[ai]), 0)) : ''
      fields['明細'] = list
        .map((r) => columns.map((_, i) => (i === ni ? '' : (r[i] ?? '').trim())).filter(Boolean).join(' · '))
        .map((line) => `• ${line}`)
        .join('\n')
      run('INSERT INTO payroll_items (run_id, instructor_name, fields, message) VALUES (?, ?, ?, ?)',
        runId, name, JSON.stringify(fields), render(template, fields))
      // New names are added to the instructor list, ready for their WhatsApp number.
      run('INSERT OR IGNORE INTO instructors (name) VALUES (?)', name)
    }
    return runId
  })
}

export function getRun(runId: number) {
  const runRow = get('SELECT * FROM payroll_runs WHERE id = ?', runId)
  if (!runRow) return undefined
  const items = all(
    `SELECT p.id, p.instructor_name, p.message, p.status, p.error, p.sent_at, i.phone, i.active
     FROM payroll_items p LEFT JOIN instructors i ON i.name = p.instructor_name
     WHERE p.run_id = ? ORDER BY p.instructor_name`,
    runId,
  )
  return { ...runRow, items }
}

export function listRuns() {
  return all(
    `SELECT r.*, u.name AS created_by_name,
       (SELECT COUNT(*) FROM payroll_items p WHERE p.run_id = r.id) AS total,
       (SELECT COUNT(*) FROM payroll_items p WHERE p.run_id = r.id AND p.status = 'sent') AS sent,
       (SELECT COUNT(*) FROM payroll_items p WHERE p.run_id = r.id AND p.status = 'failed') AS failed
     FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 24`,
  )
}

// ---------- Sending ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sending = new Set<number>()

/** Send every pending (or previously failed) payslip in a run, one by one. */
export async function sendRun(runId: number) {
  if (sending.has(runId)) return
  const settings = payrollSettings()
  if (!settings.number_id) throw new Error('請先在設定選擇用哪個 WhatsApp 號碼發送')
  const createdBy = get<{ created_by: number | null }>('SELECT created_by FROM payroll_runs WHERE id = ?', runId)?.created_by ?? null
  sending.add(runId)
  run("UPDATE payroll_runs SET status = 'sending' WHERE id = ?", runId)
  broadcast('payroll', { runId })
  try {
    const items = all<{ id: number; instructor_name: string; message: string; fields: string }>(
      "SELECT id, instructor_name, message, fields FROM payroll_items WHERE run_id = ? AND status IN ('pending','failed') ORDER BY instructor_name",
      runId,
    )
    for (const [index, item] of items.entries()) {
      const instructor = get<{ phone: string; active: number }>('SELECT phone, active FROM instructors WHERE name = ?', item.instructor_name)
      try {
        if (!instructor?.active) throw new Error('導師已停用')
        if (!instructor.phone) throw new Error('未有導師的 WhatsApp 號碼')
        const fields = JSON.parse(item.fields) as Record<string, string>
        const params = settings.wa_template_params.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
          // Template parameters may not contain line breaks.
          .map((k) => (fields[k] ?? '').replace(/\s*\n\s*/g, ' ｜ ') || '-')
        await sendToPhone(settings.number_id, instructor.phone, item.message, {
          userId: createdBy,
          template: settings.wa_template_name ? { name: settings.wa_template_name, language: settings.wa_template_language, params } : undefined,
        })
        run("UPDATE payroll_items SET status = 'sent', error = NULL, sent_at = unixepoch() WHERE id = ?", item.id)
      } catch (err) {
        run("UPDATE payroll_items SET status = 'failed', error = ? WHERE id = ?", err instanceof Error ? err.message : '發送失敗', item.id)
      }
      broadcast('payroll', { runId })
      if (index < items.length - 1) await sleep(SEND_GAP_MS)
    }
  } finally {
    sending.delete(runId)
    const left = get<{ c: number }>("SELECT COUNT(*) AS c FROM payroll_items WHERE run_id = ? AND status IN ('pending','failed')", runId)!.c
    run(`UPDATE payroll_runs SET status = ?, sent_at = CASE WHEN ? THEN unixepoch() ELSE sent_at END, scheduled_at = NULL WHERE id = ?`,
      left ? 'draft' : 'sent', left ? 0 : 1, runId)
    broadcast('payroll', { runId })
  }
}

// ---------- Schedule & month-end reminder ----------

function localParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map((p) => [p.type, p.value]),
  )
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) }
}

async function tick() {
  for (const due of all<{ id: number }>("SELECT id FROM payroll_runs WHERE status = 'scheduled' AND scheduled_at <= unixepoch()")) {
    sendRun(due.id).catch((err) => console.error('Scheduled payroll failed', err))
  }

  const settings = payrollSettings()
  if (!settings.reminder_phone || !settings.number_id) return
  const now = localParts()
  const lastDay = new Date(Date.UTC(now.year, now.month, 0)).getUTCDate()
  const month = `${now.year}-${String(now.month).padStart(2, '0')}`
  if (now.day !== lastDay || now.hour < settings.reminder_hour || getSetting('payroll_reminder_sent') === month) return
  setSetting('payroll_reminder_sent', month)
  const text = `【Baton 提醒】今日是 ${monthLabel(month)} 最後一日。請到 Vibefam 匯出本月導師糧單報表（CSV），再到 Baton「糧單」頁上載，預覽後發送給導師。`
  try {
    // A free-form text: works from a QR-linked number, or a Cloud API number the admin messaged in the last 24 hours.
    await sendToPhone(settings.number_id, normalizePhone(settings.reminder_phone), text, { userId: null })
  } catch (err) {
    console.error('Payroll reminder failed', err)
  }
}

export function startPayrollScheduler() {
  setInterval(() => { tick().catch((err) => console.error('Payroll scheduler failed', err)) }, 60_000)
}
