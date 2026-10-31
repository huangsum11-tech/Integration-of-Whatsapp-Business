/**
 * The knowledge base as a spreadsheet: export to CSV, edit in Excel or Google Sheets,
 * import back. Columns: 分類, 標題, 內容, 關鍵字 (keywords only matter for 常見問題).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, get, run, tx } from './db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = path.resolve(here, '../../docs/knowledge-template.csv')

const CATEGORIES = { faq: '常見問題', policy: '公司政策', class: '課程資料', other: '其他' } as const
type Category = keyof typeof CATEGORIES
const HEADER = ['分類', '標題', '內容', '關鍵字']

function categoryOf(value: string): Category | undefined {
  const v = value.trim().toLowerCase()
  return (Object.keys(CATEGORIES) as Category[]).find((id) => id === v || CATEGORIES[id] === value.trim())
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim()))
}

function csvField(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function exportCsv(): string {
  const rows = all<{ category: Category; title: string; body: string; keywords: string; active: number }>(
    'SELECT category, title, body, keywords, active FROM knowledge ORDER BY category, id',
  )
  const lines = [HEADER, ...rows.filter((r) => r.active).map((r) => [CATEGORIES[r.category], r.title, r.body, r.keywords])]
  // The BOM makes Excel open the file as UTF-8, so Chinese text displays correctly.
  return '﻿' + lines.map((l) => l.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/**
 * Add rows from a CSV. A row whose category and title already exist updates that entry,
 * so the same spreadsheet can be edited and imported again. With replace, entries not in
 * the file are deleted.
 */
export function importCsv(text: string, replace = false) {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('檔案是空的')
  const header = rows[0].map((h) => h.trim())
  const col = (name: string, fallback: number) => (header.includes(name) ? header.indexOf(name) : fallback)
  const hasHeader = header.includes('標題') || header.includes('title')
  const [ci, ti, bi, ki] = [col('分類', 0), col('標題', 1), col('內容', 2), col('關鍵字', 3)]
  const errors: string[] = []
  let added = 0
  let updated = 0
  tx(() => {
    const seen: number[] = []
    rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
      const line = i + (hasHeader ? 2 : 1)
      const category = categoryOf(r[ci] ?? '')
      const title = (r[ti] ?? '').trim()
      const body = (r[bi] ?? '').trim()
      const keywords = (r[ki] ?? '').trim()
      if (!category) return errors.push(`第 ${line} 行：分類「${r[ci] ?? ''}」不正確（要用 常見問題／公司政策／課程資料／其他）`)
      if (!title || !body) return errors.push(`第 ${line} 行：標題和內容不可以空白`)
      const existing = get<{ id: number }>('SELECT id FROM knowledge WHERE category = ? AND title = ?', category, title)
      if (existing) {
        run('UPDATE knowledge SET body = ?, keywords = ?, active = 1, updated_at = unixepoch() WHERE id = ?', body, keywords, existing.id)
        seen.push(existing.id); updated++
      } else {
        seen.push(Number(run('INSERT INTO knowledge (category, title, body, keywords) VALUES (?, ?, ?, ?)', category, title, body, keywords).lastInsertRowid))
        added++
      }
    })
    if (errors.length) throw new ImportError(errors)
    if (replace) run(`DELETE FROM knowledge WHERE id NOT IN (${seen.map(() => '?').join(',') || 'NULL'})`, ...seen)
  })
  return { added, updated }
}

export class ImportError extends Error {
  constructor(public problems: string[]) {
    super(problems.slice(0, 5).join('；') + (problems.length > 5 ? `；另外 ${problems.length - 5} 個問題` : ''))
  }
}

export function importTemplate() {
  return importCsv(fs.readFileSync(TEMPLATE_PATH, 'utf8'))
}
