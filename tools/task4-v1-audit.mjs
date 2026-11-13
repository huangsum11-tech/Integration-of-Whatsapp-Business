#!/usr/bin/env node
/**
 * TASK-4：評估舊 Baton v1 資料併入現行 Baton（只讀盤點）
 *
 * 只喺 Mac 本機執行。做法：
 *   1. 將資料庫（baton.db 及 -wal／-shm）複製去臨時資料夾，只開副本，唯讀。生產資料庫一個 byte 都唔會改。
 *   2. 只計數量、日期範圍、百分比；唔讀訊息內容，唔輸出任何客人電話號碼或名稱。
 *   3. 報告寫入 --out 指定位置；完成後刪除臨時副本。
 *
 * 用法（先 Ctrl+C 停止 Baton，再喺終端機執行）：
 *   node tools/task4-v1-audit.mjs --v1 "<v1 資料夾或 baton.db>" [--current "<現行資料夾或 baton.db>"] --out "<報告.md>"
 * 資料夾會自動搵：<資料夾>/baton.db、<資料夾>/data/baton.db、<資料夾>/server/data/baton.db
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ---------- 參數 ----------
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
if (!args.v1 || !args.out) {
  console.error('用法：node tools/task4-v1-audit.mjs --v1 "<v1 資料夾>" [--current "<現行資料夾>"] --out "<報告.md>"')
  process.exit(1)
}

function findDb(p) {
  if (!p) return undefined
  const abs = path.resolve(p)
  const candidates = abs.endsWith('.db') ? [abs] : [path.join(abs, 'baton.db'), path.join(abs, 'data', 'baton.db'), path.join(abs, 'server', 'data', 'baton.db')]
  const found = candidates.find((c) => fs.existsSync(c))
  if (!found) {
    console.error(`搵唔到 baton.db：${candidates.join('、')}`)
    process.exit(1)
  }
  return found
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-task4-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** Copy the database files and open the copy read-only; the original is never opened. */
function openCopy(dbPath, label) {
  const dir = path.join(tmp, label)
  fs.mkdirSync(dir)
  const wal = `${dbPath}-wal`
  const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, path.join(dir, 'baton.db' + suffix))
  // The copy may need its WAL merged before a read-only open can see every row.
  const rw = new DatabaseSync(path.join(dir, 'baton.db'))
  rw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  rw.close()
  return { db: new DatabaseSync(path.join(dir, 'baton.db'), { readOnly: true }), dataDir: path.dirname(dbPath), walBytes }
}

// ---------- 工具 ----------
const q = (db, sql, ...p) => db.prepare(sql).all(...p)
const one = (db, sql, ...p) => db.prepare(sql).get(...p)
const tables = (db) => q(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").map((r) => r.name)
const columns = (db, t) => q(db, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name)
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
const day = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—')
const mask = (phone) => (phone ? `****${String(phone).slice(-4)}` : '—')
const digits = (jid) => (jid ? jid.split('@')[0].split(':')[0] : '')
const isLidJid = (jid) => /@(hosted\.)?lid$/.test(jid ?? '')
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`)

function version(db) {
  const t = tables(db)
  if (t.includes('brands')) return '現行版本（11 月起）'
  if (columns(db, 'contacts').includes('lid')) return 'v1 LID 版（10 月 18 日 03acca7）'
  return 'v1 早期版（10 月 18 日 2c7b24d／edcec34）'
}

/** Every customer classified as having a real number, or only a LID (with or without a name). */
function identities(db) {
  const hasLid = columns(db, 'contacts').includes('lid')
  const hasSaved = columns(db, 'contacts').includes('saved_name')
  const rows = q(db, `SELECT ct.id, ct.phone, ${hasLid ? 'ct.lid' : 'NULL AS lid'}, ct.name, ${hasSaved ? 'ct.saved_name' : 'NULL AS saved_name'}, ct.wa_name,
    (SELECT GROUP_CONCAT(cv.jid, ' ') FROM conversations cv WHERE cv.contact_id = ct.id) AS jids FROM contacts ct`)
  return rows.map((r) => {
    const jids = (r.jids ?? '').split(' ').filter(Boolean)
    const lidJid = jids.find(isLidJid)
    // Unresolved: the stored "phone" is really the LID digits.
    const lid = r.lid ?? (lidJid ? digits(lidJid) : null)
    const lidOnly = Boolean(lid && r.phone === lid)
    const named = Boolean(r.name || r.saved_name || r.wa_name)
    return { id: r.id, phone: lidOnly ? null : r.phone, lid, lidOnly, named, hasSavedName: Boolean(r.saved_name) }
  })
}

/** LID -> phone mappings Baileys kept in the WhatsApp login folder (auth/<n>/lid-mapping-<lid>_reverse.json). */
function authMappings(dataDir) {
  const map = new Map()
  const authDir = path.join(dataDir, 'auth')
  if (!fs.existsSync(authDir)) return { map, folders: 0 }
  const folders = fs.readdirSync(authDir).filter((d) => fs.statSync(path.join(authDir, d)).isDirectory())
  for (const f of folders) {
    for (const file of fs.readdirSync(path.join(authDir, f))) {
      const m = file.match(/^lid-mapping-(\d+)_reverse\.json$/)
      if (!m) continue
      try {
        const pn = JSON.parse(fs.readFileSync(path.join(authDir, f, file), 'utf8'))
        if (typeof pn === 'string' && /^\d+$/.test(pn)) map.set(m[1], pn)
      } catch { /* unreadable file: skip */ }
    }
  }
  return { map, folders: folders.length }
}

function mediaStats(db, dataDir) {
  const refs = q(db, 'SELECT media_path FROM messages WHERE media_path IS NOT NULL').map((r) => r.media_path)
  const mediaDir = path.join(dataDir, 'media')
  let present = 0
  let bytes = 0
  for (const rel of refs) {
    const file = path.join(mediaDir, rel)
    if (fs.existsSync(file)) { present++; bytes += fs.statSync(file).size }
  }
  return { referenced: refs.length, present, missing: refs.length - present, bytes }
}

// ---------- 盤點 ----------
const v1Path = findDb(args.v1)
const curPath = args.current ? findDb(args.current) : undefined
if (curPath && path.resolve(curPath) === path.resolve(v1Path)) {
  console.error('--v1 同 --current 係同一個資料庫，請檢查路徑')
  process.exit(1)
}
const v1 = openCopy(v1Path, 'v1')
const cur = curPath ? openCopy(curPath, 'current') : undefined

function inventory({ db, dataDir }) {
  const count = (t) => (tables(db).includes(t) ? one(db, `SELECT COUNT(*) c FROM ${t}`).c : 0)
  const range = one(db, 'SELECT MIN(ts) a, MAX(ts) b FROM messages')
  return {
    version: version(db),
    users: count('users'), numbers: count('numbers'), contacts: count('contacts'), conversations: count('conversations'),
    messages: count('messages'), events: count('events'), deals: count('deals'),
    from: day(range?.a), to: day(range?.b),
    inbound: one(db, 'SELECT COUNT(*) c FROM messages WHERE from_me = 0').c,
    outbound: one(db, 'SELECT COUNT(*) c FROM messages WHERE from_me = 1').c,
    byType: q(db, 'SELECT type, COUNT(*) c FROM messages GROUP BY type ORDER BY c DESC'),
    perNumber: q(db, `SELECT n.label, n.phone, n.status, COUNT(DISTINCT c.id) convs, COUNT(m.id) msgs FROM numbers n
      LEFT JOIN conversations c ON c.number_id = n.id LEFT JOIN messages m ON m.conversation_id = c.id GROUP BY n.id ORDER BY n.id`),
    media: mediaStats(db, dataDir),
  }
}

const inv1 = inventory(v1)
const invCur = cur ? inventory(cur) : undefined

// ② 身分可解度
const ids = identities(v1.db)
const real = ids.filter((i) => !i.lidOnly)
const lidOnly = ids.filter((i) => i.lidOnly)
const lidNamed = lidOnly.filter((i) => i.named)
const lidNameless = lidOnly.filter((i) => !i.named)
const v1Tables = tables(v1.db)
const lidMapTable = v1Tables.includes('lid_map') ? new Map(q(v1.db, 'SELECT lid, pn FROM lid_map').map((r) => [r.lid, r.pn])) : new Map()
const auth = authMappings(v1.dataDir)
const curAuth = cur ? authMappings(cur.dataDir) : { map: new Map(), folders: 0 }
const fromTable = lidOnly.filter((i) => lidMapTable.has(i.lid))
const fromAuth = lidOnly.filter((i) => !lidMapTable.has(i.lid) && (auth.map.has(i.lid) || curAuth.map.has(i.lid)))
const recoverable = [...fromTable, ...fromAuth]
const realPhones = new Set(real.map((i) => i.phone))
const recoveredPn = (i) => lidMapTable.get(i.lid) ?? auth.map.get(i.lid) ?? curAuth.map.get(i.lid)
const wouldMerge = recoverable.filter((i) => realPhones.has(recoveredPn(i)))
const phonebook = v1Tables.includes('phonebook') ? one(v1.db, 'SELECT COUNT(*) c FROM phonebook').c : null

// 與現行資料庫重疊
let overlap
if (cur) {
  const curIds = identities(cur.db)
  const curPhones = new Set(curIds.filter((i) => i.phone).map((i) => i.phone))
  const curLids = new Set(curIds.filter((i) => i.lid).map((i) => i.lid))
  const sameCustomer = ids.filter((i) => (i.phone && curPhones.has(i.phone)) || (i.lid && curLids.has(i.lid)) || (i.lidOnly && recoveredPn(i) && curPhones.has(recoveredPn(i))))
  const curWaIds = new Set(q(cur.db, 'SELECT wa_id FROM messages').map((r) => r.wa_id))
  const dupMessages = q(v1.db, 'SELECT wa_id FROM messages').filter((r) => curWaIds.has(r.wa_id)).length
  const curNumberTails = new Set(q(cur.db, 'SELECT phone FROM numbers WHERE phone IS NOT NULL').map((r) => String(r.phone).slice(-8)))
  const v1Numbers = q(v1.db, 'SELECT label, phone FROM numbers')
  overlap = {
    sameCustomer: sameCustomer.length,
    dupMessages,
    numbers: v1Numbers.map((n) => ({ label: n.label, phone: mask(n.phone), inCurrent: n.phone ? curNumberTails.has(String(n.phone).slice(-8)) : false })),
    dateOverlap: invCur.messages && inv1.messages && !(inv1.to < invCur.from || invCur.to < inv1.from),
  }
}

// ③ 資料表對照
function schemaDiff() {
  if (!cur) return null
  const curTables = tables(cur.db)
  return v1Tables.map((t) => {
    if (!curTables.includes(t)) return { table: t, status: '❌ 現行版本冇呢個表' }
    const missing = columns(v1.db, t).filter((c) => !columns(cur.db, t).includes(c))
    const added = columns(cur.db, t).filter((c) => !columns(v1.db, t).includes(c))
    return { table: t, status: missing.length ? `⚠️ 現行版本缺少欄位：${missing.join('、')}` : '✅ v1 所有欄位都有', added: added.join('、') || '—' }
  }).concat(curTables.filter((t) => !v1Tables.includes(t)).length ? [{ table: `（現行新增 ${curTables.filter((t) => !v1Tables.includes(t)).length} 個表）`, status: curTables.filter((t) => !v1Tables.includes(t)).join('、'), added: '' }] : [])
}
const diff = schemaDiff()

// ---------- 建議 ----------
let recommendation
if (!cur || invCur.messages === 0) {
  recommendation = '**方案 A（原地升級）**：現行資料庫未有對話，直接用現行 Baton 開 v1 資料夾的副本即可，覆蓋率 100%，唔使寫合併程式。'
} else if (overlap && overlap.sameCustomer / Math.max(1, ids.length) > 0.8 && overlap.dupMessages / Math.max(1, inv1.messages) > 0.8) {
  recommendation = '**方案 C（封存唯讀）**：v1 大部分客人及訊息已經喺現行資料庫，併入得益細；保留 v1 副本作唯讀查閱即可。'
} else {
  recommendation = '**方案 B（合併）**：現行資料庫已有對話，而 v1 有現行冇嘅客人／訊息，要用合併程式；先喺副本 dry run。'
}

// ---------- 報告 ----------
const L = []
const row = (...cells) => L.push(`| ${cells.join(' | ')} |`)
L.push('# 評估：舊 Baton v1 資料併入現行 Baton（v1）', '')
L.push(`產生時間：${new Date().toLocaleString('zh-HK', { hour12: false })}（本機執行 評估_v1盤點.mjs，只讀副本）`, '')
L.push('> 私隱：本報告只有數量、日期及百分比。冇訊息內容、冇客人名稱、冇完整電話號碼（號碼只顯示末 4 位）。生產資料庫冇被開啟或修改。', '')
L.push('## 結論', '', recommendation, '')
L.push(`- v1：${inv1.contacts} 位客人、${inv1.conversations} 個對話、${inv1.messages} 條訊息（${inv1.from} 至 ${inv1.to}）`)
L.push(`- 身分：有真號碼 ${real.length}（${pct(real.length, ids.length)}）；只有 LID ${lidOnly.length}（${pct(lidOnly.length, ids.length)}），其中可以救返真號碼 ${recoverable.length}`)
if (overlap) L.push(`- 與現行資料庫重疊：同一客人 ${overlap.sameCustomer}／${ids.length}；重複訊息 ${overlap.dupMessages}／${inv1.messages}`)
L.push('')

L.push('## ① v1 資料庫存量', '')
L.push(`版本：${inv1.version}　｜　資料庫：…/${path.basename(path.dirname(v1Path))}/${path.basename(v1Path)}${v1.walBytes ? `　｜　⚠️ 盤點時有未寫入的 WAL（${fmtBytes(v1.walBytes)}），請確認 Baton 已停止` : ''}`, '')
row('項目', 'v1', invCur ? '現行' : ''); row('---', '---:', invCur ? '---:' : '')
for (const [k, label] of [['users', '同事帳戶'], ['numbers', 'WhatsApp 號碼'], ['contacts', '客人'], ['conversations', '對話'], ['messages', '訊息'], ['inbound', '　收到'], ['outbound', '　發出'], ['events', '交接／備註等事件'], ['deals', '成交紀錄']]) row(label, inv1[k], invCur ? invCur[k] : '')
row('訊息日期', `${inv1.from} 至 ${inv1.to}`, invCur ? `${invCur.from} 至 ${invCur.to}` : '')
row('媒體（有引用）', inv1.media.referenced, invCur ? invCur.media.referenced : '')
row('　檔案存在', `${inv1.media.present}（${fmtBytes(inv1.media.bytes)}）`, invCur ? `${invCur.media.present}（${fmtBytes(invCur.media.bytes)}）` : '')
row('　檔案遺失', inv1.media.missing, invCur ? invCur.media.missing : '')
L.push('', '訊息類型（v1）：' + inv1.byType.map((t) => `${t.type} ${t.c}`).join('、'), '')
L.push('每個號碼（v1）：', '')
row('號碼', '電話', '狀態', '對話', '訊息'); row('---', '---', '---', '---:', '---:')
for (const n of inv1.perNumber) row(n.label, mask(n.phone), n.status, n.convs, n.msgs)
L.push('')

L.push('## ② 身分可解度（v1 客人）', '')
row('類別', '人數', '佔比'); row('---', '---:', '---:')
row('有真電話號碼', real.length, pct(real.length, ids.length))
row('只有 LID，有名稱', lidNamed.length, pct(lidNamed.length, ids.length))
row('只有 LID，冇名稱', lidNameless.length, pct(lidNameless.length, ids.length))
row('**只有 LID 合計**', lidOnly.length, pct(lidOnly.length, ids.length))
L.push('', '只有 LID 嘅客人，可以救返真號碼的來源：', '')
row('來源', '可救返人數'); row('---', '---:')
row('v1 資料庫 lid_map 表', v1Tables.includes('lid_map') ? fromTable.length : 'v1 早期版冇呢個表')
row(`WhatsApp 登入資料夾（v1 ${auth.folders} 個號碼${cur ? `、現行 ${curAuth.folders} 個` : ''}；lid-mapping 檔共 ${auth.map.size + curAuth.map.size} 個）`, fromAuth.length)
row('**合計可救返**', `${recoverable.length}（${pct(recoverable.length, lidOnly.length)} 的 LID 客人）`)
row('救返後會同現有客人合併', wouldMerge.length)
row('仍然無法解析', lidOnly.length - recoverable.length)
L.push('', `手機通訊錄名稱（phonebook 表）：${phonebook === null ? 'v1 早期版冇呢個表' : `${phonebook} 筆`}`, '')
L.push('「仍然無法解析」的客人，對話紀錄照樣保留，畫面顯示「號碼未解析」；客人下次傳訊息時，WhatsApp 通常會提供真號碼，屆時自動補上及合併。', '')

L.push('## ③ v1 與現行資料表逐表對照', '')
if (diff) {
  row('v1 資料表', '併入時', '現行新增欄位'); row('---', '---', '---')
  for (const d of diff) row(d.table, d.status, d.added)
} else {
  L.push('（未提供 --current，以程式碼對照為準：v1 的所有表及欄位，現行版本全部保留，冇刪任何欄位；現行另加 20 至 22 個表，視乎 v1 是早期版還是 LID 版。）')
}
L.push('', '程式碼層面（已用示範資料實測）：現行 Baton 的 db.ts 用 `CREATE TABLE IF NOT EXISTS` 及 `ALTER TABLE ADD COLUMN` 升級，唔會刪資料。v1 早期版（2c7b24d）及 LID 版（03acca7）的示範資料庫交俾現行 Baton 開啟後，7 個主要表的行數完全不變，資料表由 13／15 個升到 35 個，LID 客人自動標記為「號碼未解析」。', '')

L.push('## ④ 併入方案', '')
row('', 'A 原地升級', 'B 合併入現行資料庫', 'C 封存唯讀'); row('---', '---', '---', '---')
row('做法', '現行 Baton 直接開 v1 資料夾（副本）', '寫合併程式，將 v1 逐表搬入現行資料庫', 'v1 資料夾保留，需要時用另一個端口開一個唯讀 Baton 查閱')
row('適用', '現行資料庫未有真對話', '兩邊都有真對話', 'v1 內容大部分已在現行，或只需偶爾查舊紀錄')
row('覆蓋率', '100%（所有表、媒體、登入資料）', '客人、對話、訊息、媒體、交接、成交約 100%；同事帳戶及號碼要對應', '0% 併入，100% 保留')
row('重複對話', '不適用', '客人按電話／LID 對應；對話按「號碼＋客人」合併；訊息按 WhatsApp 訊息 ID 去重；LID 救返後再合併', '不適用')
row('主要風險', '低：已實測；要確認現行資料庫真係空', '中：號碼 ID、同事 ID、媒體路徑要重新對應；要重建全文搜尋索引', '最低；但歷史分散兩處')
row('工作量', '設定 BATON_DATA_DIR，約 10 分鐘', '要寫及測試合併程式，約半日至一日', '約 10 分鐘')
L.push('')

L.push('## ⑤ 真併入的安全做法', '')
L.push('1. **停止 Baton**（終端機 Ctrl+C），確保資料庫冇寫入中。')
L.push('2. **備份**：將 v1 資料夾及現行資料夾（整個資料夾，包括 baton.db、baton.db-wal、baton.db-shm、auth/、media/）各複製一份到 iCloud 以外的位置，例如外置硬碟；檔名加日期。')
L.push('3. **副本 dry run**：再複製一份到臨時資料夾，用 `BATON_DATA_DIR=<臨時資料夾> PORT=4100 npm start` 開，喺 http://localhost:4100 核對：客人數、對話數、隨機抽 5 個對話（只喺本機睇）、媒體能否打開。')
L.push('4. **對數**：再行一次本盤點程式（--v1 舊副本、--current dry run 結果），確認數量同預期一致、冇遺失。')
L.push('5. **切換**：確認無誤後，先停止 Baton，再把 .env 的 BATON_DATA_DIR 指向新資料夾；舊資料夾原封不動保留至少 30 日。')
L.push('6. **回滾**：如有問題，停止 Baton，把 BATON_DATA_DIR 改回舊資料夾（或用第 2 步備份還原），重新啟動即可。')
L.push('7. **紅線**：整個過程只喺 Mac 本機；資料夾不要放入 iCloud／Google Drive／Notion；報告只寫數量。', '')

fs.writeFileSync(path.resolve(args.out), L.join('\n') + '\n')
console.log(`完成：報告已寫入 ${path.resolve(args.out)}`)
console.log(recommendation.replace(/\*\*/g, ''))
