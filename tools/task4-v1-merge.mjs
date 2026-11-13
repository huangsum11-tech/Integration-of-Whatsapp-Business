#!/usr/bin/env node
/**
 * TASK-4 方案 B：將舊 Baton v1（WhatsApp Web）資料合併入現行 Baton 資料庫。
 *
 * 只喺 Mac 本機執行，而且先停 Baton。v1 只讀（複製去臨時資料夾先開）；只會寫入 --target。
 * 正式合併前，先將現行資料夾複製一份做 --target 試併，核對無誤先對正本做。
 *
 *   node tools/task4-v1-merge.mjs --v1 "<v1 資料夾>" --target "<要寫入嘅資料夾>" [--apply]
 *
 * 冇 --apply 只會計數（乜都唔寫）。資料夾要有 baton.db；v1 資料夾嘅 auth/ 用嚟將 LID 換返真號碼，
 * media/ 會複製去 target 嘅 media/（唔覆蓋已有檔案）。
 *
 * 規則：
 * - v1 所有對話掛去 target 入面同一個電話嘅 WhatsApp 號碼（例如 Cloud API 嗰個），唔會新增 wa_web 號碼。
 * - 客人按電話對應；LID 客人用 auth/ 嘅 lid-mapping 換真號碼，換唔到就保留 LID（畫面顯示「號碼未解析」）。
 * - 對話按「號碼＋jid」合併；訊息按 WhatsApp 訊息 ID 去重；全文搜尋由資料庫 trigger 自動建立。
 * - 只喺 v1 出現嘅對話設為「已完成」及已讀，唔會塞爆收件匣；同現行重疊嘅對話維持現狀。
 * - v1 冇對話嘅通訊錄聯絡人只入 phonebook（手機通訊錄名），唔開客人紀錄。
 * - 終端機只輸出數量，唔輸出訊息、名稱或號碼。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []))
if (!args.v1 || !args.target || args.v1 === true || args.target === true) {
  console.error('用法：node tools/task4-v1-merge.mjs --v1 "<v1 資料夾>" --target "<資料夾>" [--apply]')
  process.exit(1)
}
const apply = Boolean(args.apply)
const v1Dir = path.resolve(args.v1)
const targetDir = path.resolve(args.target)
for (const d of [v1Dir, targetDir]) {
  if (!fs.existsSync(path.join(d, 'baton.db'))) { console.error(`搵唔到 ${path.join(d, 'baton.db')}`); process.exit(1) }
}
if (v1Dir === targetDir) { console.error('--v1 同 --target 唔可以係同一個資料夾'); process.exit(1) }

// ---------- v1：複製後唯讀 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-merge-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(path.join(v1Dir, 'baton.db' + s))) fs.copyFileSync(path.join(v1Dir, 'baton.db' + s), path.join(tmp, 'baton.db' + s))
{ const rw = new DatabaseSync(path.join(tmp, 'baton.db')); rw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); rw.close() }
const v1 = new DatabaseSync(path.join(tmp, 'baton.db'), { readOnly: true })
const db = new DatabaseSync(path.join(targetDir, 'baton.db'))
db.exec('PRAGMA foreign_keys = ON')

const all = (d, sql, ...p) => d.prepare(sql).all(...p)
const get = (d, sql, ...p) => d.prepare(sql).get(...p)
const cols = (d, t) => all(d, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name)
for (const t of ['contacts', 'conversations', 'messages', 'phonebook', 'lid_map']) {
  if (!cols(db, t).length) { console.error(`target 冇 ${t} 表：請先用現行 Baton 開一次 target 資料夾`); process.exit(1) }
}

// ---------- LID -> 真號碼 ----------
const lidToPn = new Map()
const authRoot = path.join(v1Dir, 'auth')
if (fs.existsSync(authRoot)) {
  for (const f of fs.readdirSync(authRoot)) {
    const dir = path.join(authRoot, f)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(/^lid-mapping-(\d+)_reverse\.json$/)
      if (!m) continue
      try { const pn = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); if (typeof pn === 'string' && /^\d+$/.test(pn)) lidToPn.set(m[1], pn) } catch { /* skip */ }
    }
  }
}
for (const r of cols(v1, 'lid_map').length ? all(v1, 'SELECT lid, pn FROM lid_map') : []) lidToPn.set(r.lid, r.pn)
for (const r of all(db, 'SELECT lid, pn FROM lid_map')) if (!lidToPn.has(r.lid)) lidToPn.set(r.lid, r.pn)

const isLid = (jid) => /@(hosted\.)?lid$/.test(jid ?? '')
const userPart = (jid) => jid.split('@')[0].split(':')[0]

// ---------- 號碼對應 ----------
const v1Numbers = all(v1, 'SELECT id, phone FROM numbers')
const targetNumbers = all(db, "SELECT id, phone, channel FROM numbers WHERE channel IN ('wa_cloud','wa_web') AND phone IS NOT NULL")
const numberMap = new Map()
for (const n of v1Numbers) {
  const tail = String(n.phone ?? '').slice(-8)
  const match = targetNumbers.find((t) => String(t.phone).slice(-8) === tail && t.channel === 'wa_cloud') ?? targetNumbers.find((t) => String(t.phone).slice(-8) === tail)
  if (!match) { console.error(`v1 號碼 #${n.id} 喺 target 搵唔到同一個電話，停止（唔會自動新增號碼）`); process.exit(1) }
  numberMap.set(n.id, match.id)
}

// ---------- 計劃 ----------
const v1HasLid = cols(v1, 'contacts').includes('lid')
const v1Contacts = all(v1, `SELECT id, phone, name, wa_name, notes, created_at, updated_at${v1HasLid ? ', lid' : ', NULL AS lid'} FROM contacts`)
const v1Convs = all(v1, 'SELECT id, number_id, contact_id, jid, status, last_message_at, last_preview FROM conversations')
const convByContact = new Map()
for (const c of v1Convs) convByContact.set(c.contact_id, [...(convByContact.get(c.contact_id) ?? []), c])

const stats = { contactsNew: 0, contactsMatched: 0, lidResolved: 0, lidUnresolved: 0, phonebook: 0, convsNew: 0, convsMerged: 0, messagesNew: 0, messagesDup: 0, mediaCopied: 0, mediaSkipped: 0, lidMap: 0 }

function resolve(contact) {
  const convs = convByContact.get(contact.id) ?? []
  const lidJid = convs.map((c) => c.jid).find(isLid)
  const lid = contact.lid ?? (lidJid ? userPart(lidJid) : null)
  const lidOnly = Boolean(lid && contact.phone === lid)
  const pn = lidOnly ? lidToPn.get(lid) ?? null : contact.phone
  return { lid, lidOnly, pn }
}

const run = () => {
  const contactMap = new Map()
  for (const c of v1Contacts) {
    const convs = convByContact.get(c.id) ?? []
    const { lid, lidOnly, pn } = resolve(c)
    if (lidOnly) pn ? stats.lidResolved++ : stats.lidUnresolved++
    const key = pn ?? lid
    if (!convs.length) {
      // Contact-list entry only: keep the name for when they first message the Cloud API number.
      const name = c.name || c.wa_name
      if (name && key && !get(db, 'SELECT 1 FROM phonebook WHERE key = ?', key)) { stats.phonebook++; if (apply) db.prepare('INSERT INTO phonebook (key, name) VALUES (?, ?)').run(key, name) }
      continue
    }
    const existing = get(db, 'SELECT id FROM contacts WHERE phone = ? OR (lid IS NOT NULL AND lid = ?)', key, lid ?? '')
    if (existing) {
      stats.contactsMatched++
      contactMap.set(c.id, existing.id)
      if (apply) db.prepare(`UPDATE contacts SET wa_name = COALESCE(wa_name, ?), name = COALESCE(name, ?), lid = COALESCE(lid, ?),
        notes = CASE WHEN notes = '' THEN ? ELSE notes END WHERE id = ?`).run(c.wa_name, c.name, lid, c.notes ?? '', existing.id)
    } else {
      stats.contactsNew++
      if (apply) {
        const id = db.prepare('INSERT INTO contacts (phone, name, wa_name, notes, created_at, updated_at, lid) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(key, c.name, c.wa_name, c.notes ?? '', c.created_at, c.updated_at, lid).lastInsertRowid
        contactMap.set(c.id, Number(id))
      } else contactMap.set(c.id, -c.id)
    }
  }
  for (const [lid, pn] of lidToPn) {
    if (!get(db, 'SELECT 1 FROM lid_map WHERE lid = ?', lid)) { stats.lidMap++; if (apply) db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?)').run(lid, pn) }
  }

  const insertMsg = db.prepare(`INSERT OR IGNORE INTO messages (conversation_id, wa_id, from_me, sender_id, type, body, media_path, media_mime, ts, ai_assisted)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
  const plannedConvs = new Map()
  for (const cv of v1Convs) {
    const numberId = numberMap.get(cv.number_id)
    const contact = v1Contacts.find((c) => c.id === cv.contact_id)
    const { pn } = resolve(contact)
    const jid = isLid(cv.jid) && pn ? `${pn}@s.whatsapp.net` : cv.jid
    const key = `${numberId}|${jid}`
    let targetId = get(db, 'SELECT id FROM conversations WHERE number_id = ? AND jid = ?', numberId, jid)?.id ?? plannedConvs.get(key)
    if (targetId) stats.convsMerged++
    else {
      stats.convsNew++
      if (apply) {
        targetId = Number(db.prepare(`INSERT INTO conversations (number_id, contact_id, jid, status, unread, last_message_at, last_preview)
          VALUES (?, ?, ?, 'closed', 0, ?, ?)`).run(numberId, contactMap.get(cv.contact_id), jid, cv.last_message_at, cv.last_preview).lastInsertRowid)
      } else targetId = -cv.id
      plannedConvs.set(key, targetId)
    }
    for (const m of all(v1, 'SELECT wa_id, from_me, type, body, media_path, media_mime, ts, ai_assisted FROM messages WHERE conversation_id = ?', cv.id)) {
      const dup = targetId > 0 && get(db, 'SELECT 1 FROM messages WHERE conversation_id = ? AND wa_id = ?', targetId, m.wa_id)
      if (dup) { stats.messagesDup++; continue }
      stats.messagesNew++
      if (apply) insertMsg.run(targetId, m.wa_id, m.from_me, m.type, m.body, m.media_path, m.media_mime, m.ts, m.ai_assisted)
    }
    if (apply) {
      // Keep the latest message on top: only move last_message_at forward.
      db.prepare(`UPDATE conversations SET last_message_at = ?, last_preview = ? WHERE id = ? AND last_message_at < ?`)
        .run(cv.last_message_at, cv.last_preview, targetId, cv.last_message_at)
    }
  }

  // Media: same relative paths (<number id>/<file>); v1 number id must equal the target's.
  const v1Media = path.join(v1Dir, 'media')
  for (const m of all(v1, 'SELECT DISTINCT media_path FROM messages WHERE media_path IS NOT NULL')) {
    const from = path.join(v1Media, m.media_path)
    const v1NumberId = Number(m.media_path.split('/')[0])
    const targetNumberId = numberMap.get(v1NumberId) ?? v1NumberId
    if (targetNumberId !== v1NumberId) { console.error('媒體路徑要改號碼 id，今個版本未支援，停止'); process.exit(1) }
    const to = path.join(targetDir, 'media', m.media_path)
    if (!fs.existsSync(from) || fs.existsSync(to)) { stats.mediaSkipped++; continue }
    stats.mediaCopied++
    if (apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
  }
}

if (apply) {
  db.exec('BEGIN')
  try { run(); db.exec('COMMIT') } catch (err) { db.exec('ROLLBACK'); throw err }
} else run()

console.log(apply ? '已合併（寫入 target）：' : '試算（冇寫入任何嘢）：')
console.log(`客人：新增 ${stats.contactsNew}、對上現有 ${stats.contactsMatched}；LID 換返真號碼 ${stats.lidResolved}、未解析 ${stats.lidUnresolved}`)
console.log(`通訊錄名（phonebook）新增 ${stats.phonebook}；lid_map 新增 ${stats.lidMap}`)
console.log(`對話：新增 ${stats.convsNew}、併入現有 ${stats.convsMerged}`)
console.log(`訊息：新增 ${stats.messagesNew}、重複略過 ${stats.messagesDup}`)
console.log(`媒體：複製 ${stats.mediaCopied}、略過 ${stats.mediaSkipped}`)
