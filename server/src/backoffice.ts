/**
 * Booking-system back office (Vibefam) in a real browser, ASSIST MODE ONLY (stage 2):
 * log in with the dedicated staff account, find the member by phone, open "add package",
 * choose the verified package — and stop on the confirmation screen for a teammate to check
 * and press confirm themselves. Nothing here ever presses the final confirm (stage 3 is not
 * enabled until Sum approves it).
 *
 * Every run is audited: each step with time, result and a screenshot, stored locally under
 * data/backoffice/. Anything unexpected — member not found, several matches, a screen that
 * does not look as expected, a login check (2FA / CAPTCHA) — stops the run and tells the team.
 *
 * Credentials come only from .env (VIBEFAM_ADMIN_URL, VIBEFAM_USERNAME, VIBEFAM_PASSWORD).
 * The screens are described by a selector profile (no secrets), set once in the settings.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { brandById } from './brands.js'
import { DATA_DIR, all, get, getSetting, run, setSetting } from './db.js'
import { addEvent } from './inbox.js'
import { getRequest } from './payments.js'
import { broadcast } from './realtime.js'

export const STAGE = 2 as const

const DIR = path.join(DATA_DIR, 'backoffice')
const STATE = path.join(DIR, 'session.json')

/** How the back office looks. Every key is a CSS / Playwright selector; nothing secret. */
export interface Profile {
  login: { username: string; password: string; submit: string; loggedIn: string }
  search: { url?: string; input: string; submit?: string; results: string; empty?: string }
  member: { open?: string; addPackage: string }
  form: { packageSelect: string; confirm: string }
  /** Text on a page that means a login check we must not bypass. */
  challenge: string
}

export const EXAMPLE_PROFILE: Profile = {
  login: { username: 'input[type="email"]', password: 'input[type="password"]', submit: 'button[type="submit"]', loggedIn: 'text=Members' },
  search: { url: '/members', input: 'input[type="search"]', results: 'table tbody tr', empty: 'text=No results' },
  member: { open: 'a', addPackage: 'button:has-text("Add Package")' },
  form: { packageSelect: 'select[name="package"]', confirm: 'button:has-text("Confirm")' },
  challenge: 'captcha|recaptcha|驗證碼|verification code|two-factor|2FA',
}

export function profile(): Profile | null {
  const raw = getSetting('backoffice_profile')
  try { return raw ? JSON.parse(raw) as Profile : null } catch { return null }
}

export function saveProfile(p: Profile) {
  setSetting('backoffice_profile', JSON.stringify(p))
}

export function backofficeStatus() {
  const missing = [
    !process.env.VIBEFAM_ADMIN_URL && 'VIBEFAM_ADMIN_URL',
    !process.env.VIBEFAM_USERNAME && 'VIBEFAM_USERNAME',
    !process.env.VIBEFAM_PASSWORD && 'VIBEFAM_PASSWORD',
  ].filter(Boolean) as string[]
  const p = profile()
  return {
    stage: STAGE,
    enabled: getSetting('backoffice_enabled', '0') === '1' && missing.length === 0 && Boolean(p),
    switchedOn: getSetting('backoffice_enabled', '0') === '1',
    missingEnv: missing,
    hasProfile: Boolean(p),
    headless: process.env.BATON_BACKOFFICE_HEADLESS === '1',
  }
}

// ---------- Run log ----------

interface Step { at: number; step: string; ok: boolean; note: string; shot?: string }

class RunLog {
  id: number
  steps: Step[] = []
  dir: string
  constructor(kind: string, requestId: number | null, userId: number | null, target: string) {
    this.id = Number(run('INSERT INTO automation_runs (kind, request_id, user_id, status, target) VALUES (?, ?, ?, ?, ?)', kind, requestId, userId, 'running', target).lastInsertRowid)
    this.dir = path.join(DIR, 'runs', String(this.id))
    fs.mkdirSync(this.dir, { recursive: true })
  }
  async step(page: Page | null, step: string, ok: boolean, note = '') {
    let shot: string | undefined
    if (page) {
      shot = path.join('runs', String(this.id), `${String(this.steps.length + 1).padStart(2, '0')}-${step}.png`)
      await page.screenshot({ path: path.join(DIR, shot), fullPage: true }).catch(() => { shot = undefined })
    }
    this.steps.push({ at: Math.floor(Date.now() / 1000), step, ok, note, shot })
    run('UPDATE automation_runs SET log = ? WHERE id = ?', JSON.stringify(this.steps), this.id)
  }
  finish(status: 'awaiting_confirmation' | 'stopped' | 'failed', detail: string) {
    run('UPDATE automation_runs SET status = ?, detail = ?, ended_at = unixepoch() WHERE id = ?', status, detail, this.id)
    broadcast('payment', {})
    return { runId: this.id, status, detail }
  }
}

/** Something on screen is not as expected: stop, never guess or click around. */
class Stop extends Error {}

// ---------- Browser ----------

const open = new Map<number, { browser: Browser; context: BrowserContext; timer: NodeJS.Timeout }>()

async function launch() {
  const { chromium } = await import('playwright-core')
  const headless = process.env.BATON_BACKOFFICE_HEADLESS === '1'
  const executablePath = process.env.BATON_BROWSER_PATH || undefined
  const candidates = executablePath ? [{ executablePath }] : [{ channel: 'chrome' }, { executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }, {}]
  let lastError: unknown
  for (const options of candidates) {
    try { return await chromium.launch({ headless, ...options }) } catch (err) { lastError = err }
  }
  throw new Error(`未能開啟瀏覽器：請安裝 Google Chrome，或在 .env 設定 BATON_BROWSER_PATH（${lastError instanceof Error ? lastError.message.split('\n')[0] : ''}）`)
}

async function expectVisible(page: Page, selector: string, what: string, timeout = 8000) {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout })
  } catch {
    throw new Stop(`畫面與預期不符：找不到${what}（${selector}）`)
  }
}

async function checkChallenge(page: Page, p: Profile) {
  // Visible text only: many login pages load a CAPTCHA script without showing a check.
  const text = await page.locator('body').innerText().catch(() => '')
  if (new RegExp(p.challenge, 'i').test(text)) throw new Stop('後台要求額外驗證（雙重驗證／CAPTCHA）：請同事在瀏覽器手動完成登入，系統不會繞過')
}

/** "85291234567" → "91234567" (how a Hong Kong back office usually stores it). */
export function localPhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  return digits.startsWith('852') && digits.length === 11 ? digits.slice(3) : digits
}

/**
 * Assist a teammate: fill in "add package" for a VERIFIED payment and stop before confirming.
 * Returns once the form is ready (the browser stays open for the teammate) or the run stopped.
 */
export async function assistAddPackage(requestId: number, userId: number) {
  const status = backofficeStatus()
  if (!status.enabled) throw new Error('後台輔助未啟用或未設定：請在 .env 填寫帳戶並在設定填寫畫面設定')
  const r = getRequest(requestId)
  if (!r) throw new Error('找不到付款請求')
  // Money rule: never touch the back office for a payment nobody has verified.
  if (r.status !== 'verified' || !r.verified_by) throw new Error('只可以為已核實的付款加入套票')
  const contact = get<{ phone: string }>('SELECT phone FROM contacts WHERE id = ?', r.contact_id)
  if (!contact || !/^\d{8,}$/.test(contact.phone)) throw new Error('客人未有可搜尋的電話號碼（號碼未解析）')
  const pkg = r.package_id ? get<{ backoffice_name: string }>('SELECT backoffice_name FROM packages WHERE id = ?', r.package_id) : undefined
  const packageName = pkg?.backoffice_name || r.package_label
  const p = profile()!
  const phone = localPhone(contact.phone)
  const log = new RunLog('add_package', r.id, userId, `${r.ref} ${brandById(r.brand_id)?.name ?? ''} ${phone} ${packageName}`)

  fs.mkdirSync(DIR, { recursive: true })
  const browser = await launch()
  const context = await browser.newContext(fs.existsSync(STATE) ? { storageState: STATE } : {})
  const page = await context.newPage()
  const keepOpen = () => {
    // Leave the window for the teammate; close it after 30 minutes either way.
    const timer = setTimeout(() => closeRun(log.id), 30 * 60_000)
    open.set(log.id, { browser, context, timer })
  }

  try {
    const base = process.env.VIBEFAM_ADMIN_URL!
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await checkChallenge(page, p)
    if (!(await page.locator(p.login.loggedIn).first().isVisible().catch(() => false))) {
      await expectVisible(page, p.login.username, '登入欄')
      await page.fill(p.login.username, process.env.VIBEFAM_USERNAME!)
      await page.fill(p.login.password, process.env.VIBEFAM_PASSWORD!)
      await page.click(p.login.submit)
      await page.waitForLoadState('domcontentloaded')
      await checkChallenge(page, p)
      await expectVisible(page, p.login.loggedIn, '登入後的畫面')
      await context.storageState({ path: STATE })
    }
    await log.step(page, 'login', true, '已登入（專用員工帳戶）')

    if (p.search.url) await page.goto(new URL(p.search.url, base).toString(), { waitUntil: 'domcontentloaded' })
    await expectVisible(page, p.search.input, '會員搜尋欄')
    await page.fill(p.search.input, phone)
    if (p.search.submit) await page.click(p.search.submit)
    else await page.press(p.search.input, 'Enter')
    await page.waitForTimeout(800)
    const rows = page.locator(p.search.results)
    const count = await rows.count()
    if (count === 0) {
      await log.step(page, 'search', false, `找不到電話 ${phone} 的會員`)
      throw new Stop(`找不到會員（電話 ${phone}）`)
    }
    if (count > 1) {
      await log.step(page, 'search', false, `電話 ${phone} 有 ${count} 個會員`)
      throw new Stop(`多重匹配：電話 ${phone} 有 ${count} 個會員，請同事人手處理`)
    }
    await log.step(page, 'search', true, `找到 1 個會員（${phone}）`)

    if (p.member.open) await rows.first().locator(p.member.open).first().click()
    else await rows.first().click()
    await page.waitForLoadState('domcontentloaded')
    await expectVisible(page, p.member.addPackage, '加入套票按鈕')
    await page.click(p.member.addPackage)
    await expectVisible(page, p.form.packageSelect, '套票選擇欄')
    const select = page.locator(p.form.packageSelect).first()
    const options = await select.locator('option').allTextContents()
    const match = options.filter((o) => o.trim() === packageName.trim())
    if (match.length !== 1) {
      await log.step(page, 'form', false, `後台套票選項中${match.length ? '有多個' : '找不到'}「${packageName}」`)
      throw new Stop(`後台${match.length ? '有多個' : '找不到'}套票「${packageName}」：請在「設定 → 品牌及收款」設定後台套票名稱`)
    }
    await select.selectOption({ label: match[0] })
    await expectVisible(page, p.form.confirm, '確認按鈕')
    // Stage 2: stop here. The teammate checks the screen and presses confirm themselves.
    await log.step(page, 'ready', true, `已填好「${packageName}」，停在確認畫面，未按確認`)
    addEvent(r.conversation_id, userId, 'payment', `${r.ref} 後台輔助：已填好加入套票表格，等同事核對確認`)
    if (process.env.BATON_BACKOFFICE_HEADLESS === '1') await closeBrowser(browser)
    else keepOpen()
    return log.finish('awaiting_confirmation', '已填好表格，停在確認畫面；請同事在瀏覽器核對並按確認，然後在 Baton 按「已入帳」')
  } catch (err) {
    const stopped = err instanceof Stop
    const detail = err instanceof Error ? err.message : '執行失敗'
    await log.step(page, stopped ? 'stopped' : 'error', false, detail)
    addEvent(r.conversation_id, userId, 'ai_error', `${r.ref} 後台輔助已停止：${detail}`)
    run('UPDATE conversations SET needs_human = 1 WHERE id = ?', r.conversation_id)
    // Leave a stopped window open too, so the teammate can see where it stopped.
    if (process.env.BATON_BACKOFFICE_HEADLESS === '1') await closeBrowser(browser)
    else keepOpen()
    return log.finish(stopped ? 'stopped' : 'failed', detail)
  }
}

async function closeBrowser(browser: Browser) {
  await browser.close().catch(() => {})
}

export async function closeRun(runId: number) {
  const o = open.get(runId)
  if (!o) return
  clearTimeout(o.timer)
  open.delete(runId)
  await closeBrowser(o.browser)
}

/** Audit list: every run with its steps (screenshots stay on this computer, under data/backoffice). */
export function auditRuns(limit = 50) {
  return all<{ id: number; kind: string; request_id: number | null; user_name: string | null; status: string; target: string; detail: string | null; log: string; started_at: number; ended_at: number | null }>(
    `SELECT r.id, r.kind, r.request_id, u.name AS user_name, r.status, r.target, r.detail, r.log, r.started_at, r.ended_at
     FROM automation_runs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?`, limit,
  ).map((r) => ({ ...r, log: JSON.parse(r.log || '[]') as Step[] }))
}

/** A screenshot from a run, only by its own relative path (no path tricks). */
export function screenshotPath(rel: string) {
  if (!/^runs\/\d+\/[\w-]+\.png$/.test(rel)) return null
  const file = path.join(DIR, rel)
  return fs.existsSync(file) ? file : null
}

export const SCREENSHOT_DIR = DIR
