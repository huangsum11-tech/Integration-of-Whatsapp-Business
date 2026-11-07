/**
 * C. Back-office assist mode (stage 2) against a mock admin site in a real headless browser:
 * logs in, finds the member by phone, fills "add package" and stops on the confirm screen
 * WITHOUT pressing confirm; screenshots + audit log for every run; stops on member not found,
 * several matches, a screen that does not match, or a login check; refuses unverified payments.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, test } from 'node:test'
import { setup } from './helpers.ts'

process.env.BATON_BACKOFFICE_HEADLESS = '1'
const t = await setup()
const { db, pilates, staff, payments } = t
const bo = await import('../src/backoffice.js')

// ---------- Mock back office ----------
const members = [
  { id: 1, name: 'Amy Chan', phone: '92220001' },
  { id: 2, name: 'Twin A', phone: '92220002' },
  { id: 3, name: 'Twin B', phone: '92220002' },
]
let confirmed = 0
let challenge = false
let brokenMemberPage = false
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  const authed = /session=ok/.test(req.headers.cookie ?? '')
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (url.pathname === '/login' && req.method === 'POST') {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      const f = new URLSearchParams(data)
      if (f.get('email') === 'staff@fuse.test' && f.get('password') === 'pw') {
        res.writeHead(302, { 'set-cookie': 'session=ok; Path=/', location: '/' }).end()
      } else res.end(page('<p>Wrong password</p>'))
    })
    return
  }
  if (!authed) {
    return res.end(page(challenge
      ? '<p>Please complete the CAPTCHA</p>'
      : '<form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"><button type="submit">Log in</button></form>'))
  }
  if (url.pathname === '/') return res.end(page('<nav>Members</nav>'))
  if (url.pathname === '/members') {
    const q = url.searchParams.get('q')
    const rows = q ? members.filter((m) => m.phone === q) : []
    return res.end(page(`<nav>Members</nav><form><input type="search" name="q" value="${q ?? ''}"></form>
      <table><tbody>${rows.map((m) => `<tr><td><a href="/members/${m.id}">${m.name}</a></td><td>${m.phone}</td></tr>`).join('')}</tbody></table>`))
  }
  const m = url.pathname.match(/^\/members\/(\d+)$/)
  if (m) {
    if (brokenMemberPage) return res.end(page('<nav>Members</nav><p>New design</p>'))
    return res.end(page(`<nav>Members</nav><h1>Member ${m[1]}</h1>
      <button onclick="document.getElementById('f').style.display='block'">Add Package</button>
      <form id="f" style="display:none" method="post" action="/confirm">
        <select name="package"><option>-</option><option>Reformer 8 Classes</option><option>Reformer 12 Classes</option></select>
        <button type="submit">Confirm</button></form>`))
  }
  if (url.pathname === '/confirm') { confirmed++; return res.end(page('Package added')) }
  res.writeHead(404).end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
after(() => server.close())

process.env.VIBEFAM_ADMIN_URL = `http://127.0.0.1:${port}/`
process.env.VIBEFAM_USERNAME = 'staff@fuse.test'
process.env.VIBEFAM_PASSWORD = 'pw'
bo.saveProfile({
  ...bo.EXAMPLE_PROFILE,
  search: { url: '/members', input: 'input[type="search"]', results: 'table tbody tr' },
})
db.setSetting('backoffice_enabled', '1')
const brandId = t.brandId('pilates')
db.run("UPDATE packages SET backoffice_name = 'Reformer 8 Classes' WHERE brand_id = ? AND category LIKE '%Reformer%' AND sessions = 8", brandId)
const reformer8 = db.get<{ id: number }>("SELECT * FROM packages WHERE brand_id = ? AND backoffice_name = 'Reformer 8 Classes'", brandId)!

/** A payment for this customer, verified by a teammate unless told otherwise. */
function payment(phone: string, verified = true) {
  const s = t.say(pilates, phone, '你好')
  const pkg = db.get('SELECT * FROM packages WHERE id = ?', reformer8.id) as Parameters<typeof payments.createPaymentRequest>[2]
  const r = payments.createPaymentRequest(s.conversationId, brandId, pkg, 2080, 'quoted', '')
  if (verified) db.run("UPDATE payment_requests SET status = 'verified', verified_by = ?, verified_at = unixepoch() WHERE id = ?", staff, r.id)
  return r
}

const runOf = (id: number) => db.get<{ status: string; log: string; detail: string }>('SELECT * FROM automation_runs WHERE id = ?', id)!

test('verified payment: logs in, finds the member, fills the form, stops before confirm', async () => {
  const r = payment('85292220001')
  const out = await bo.assistAddPackage(r.id, staff)
  assert.equal(out.status, 'awaiting_confirmation', out.detail)
  assert.equal(confirmed, 0, 'never pressed confirm')
  const run = runOf(out.runId)
  const steps = JSON.parse(run.log) as { step: string; shot?: string }[]
  assert.deepEqual(steps.map((s) => s.step), ['login', 'search', 'ready'])
  for (const s of steps) assert.ok(s.shot && fs.existsSync(path.join(bo.SCREENSHOT_DIR, s.shot)), `screenshot for ${s.step}`)
  assert.equal(payments.getRequest(r.id)!.status, 'verified', 'Baton does not mark it credited by itself')
  assert.ok(!JSON.stringify(steps).includes('pw'), 'password never in the audit log')
})

test('member not found: stops and flags the team', async () => {
  const r = payment('85299999999')
  const out = await bo.assistAddPackage(r.id, staff)
  assert.equal(out.status, 'stopped')
  assert.match(out.detail, /找不到會員/)
  assert.equal(db.get<{ needs_human: number }>('SELECT needs_human FROM conversations WHERE id = ?', r.conversation_id)!.needs_human, 1)
  assert.equal(confirmed, 0)
})

test('several members with the same phone: stops (多重匹配)', async () => {
  const out = await bo.assistAddPackage(payment('85292220002').id, staff)
  assert.equal(out.status, 'stopped')
  assert.match(out.detail, /多重匹配/)
})

test('screen does not match the profile: stops (畫面與預期不符)', async () => {
  brokenMemberPage = true
  try {
    const out = await bo.assistAddPackage(payment('85292220001').id, staff)
    assert.equal(out.status, 'stopped')
    assert.match(out.detail, /畫面與預期不符/)
  } finally { brokenMemberPage = false }
})

test('package name not in the back office: stops instead of guessing', async () => {
  db.run("UPDATE packages SET backoffice_name = 'Reformer 99 Classes' WHERE id = ?", reformer8.id)
  try {
    const out = await bo.assistAddPackage(payment('85292220001').id, staff)
    assert.equal(out.status, 'stopped')
    assert.match(out.detail, /找不到套票/)
  } finally { db.run("UPDATE packages SET backoffice_name = 'Reformer 8 Classes' WHERE id = ?", reformer8.id) }
})

test('login check (CAPTCHA / 2FA): stops, never bypasses', async () => {
  fs.rmSync(path.join(bo.SCREENSHOT_DIR, 'session.json'), { force: true })
  challenge = true
  try {
    const out = await bo.assistAddPackage(payment('85292220001').id, staff)
    assert.equal(out.status, 'stopped')
    assert.match(out.detail, /額外驗證/)
  } finally { challenge = false }
})

test('unverified payment: refused before any browser opens', async () => {
  const before = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM automation_runs')!.c
  await assert.rejects(bo.assistAddPackage(payment('85292220001', false).id, staff), /已核實/)
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM automation_runs')!.c, before)
})

test('switched off or missing credentials: not enabled', () => {
  const pw = process.env.VIBEFAM_PASSWORD
  delete process.env.VIBEFAM_PASSWORD
  assert.equal(bo.backofficeStatus().enabled, false)
  assert.deepEqual(bo.backofficeStatus().missingEnv, ['VIBEFAM_PASSWORD'])
  process.env.VIBEFAM_PASSWORD = pw
  db.setSetting('backoffice_enabled', '0')
  assert.equal(bo.backofficeStatus().enabled, false)
  db.setSetting('backoffice_enabled', '1')
})

test('audit list shows every run with its steps', () => {
  const runs = bo.auditRuns()
  assert.ok(runs.length >= 6)
  assert.ok(runs.every((r) => Array.isArray(r.log) && r.log.length >= 1))
  assert.equal(bo.screenshotPath('../../etc/passwd'), null)
})
