/**
 * Demo data so the inbox can be explored without linking a real phone.
 * Run: npm run seed  (refuses to touch a database that already has users)
 * Demo login: karen@baton.demo / baton-demo
 */
import { hashPassword } from './auth.js'
import { get, run, tx } from './db.js'
import { addEvent, storeMessage } from './inbox.js'

if (get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c) {
  console.error('Database already has users; seed skipped. Delete data/ to start fresh.')
  process.exit(1)
}

const password = hashPassword('baton-demo')
const now = Math.floor(Date.now() / 1000)
const DAY = 86400

tx(() => {
  const users = [
    ['陳嘉欣 Karen', 'karen@baton.demo', 'admin', '#0E7C66', '語氣親切，會用「😊」，句尾常加「呀」「喎」'],
    ['李家豪 Ho', 'ho@baton.demo', 'agent', '#F26B4F', '簡潔直接，多用英文夾中文'],
    ['黃美琪 Maggie', 'maggie@baton.demo', 'agent', '#6C5CE7', '有禮貌，用書面語'],
    ['張志偉 Wai', 'wai@baton.demo', 'agent', '#D99A1E', ''],
  ].map(([name, email, role, color, notes]) =>
    Number(run('INSERT INTO users (name, email, password_hash, role, color, style_notes) VALUES (?, ?, ?, ?, ?, ?)',
      name, email, password, role, color, notes).lastInsertRowid))
  const [karen, ho, maggie, wai] = users

  const sales = Number(run("INSERT INTO numbers (label, phone, status, demo) VALUES ('銷售熱線', '85291234567', 'demo', 1)").lastInsertRowid)
  const service = Number(run("INSERT INTO numbers (label, phone, status, demo) VALUES ('客戶服務', '85298765432', 'demo', 1)").lastInsertRowid)

  type Line = [fromMe: 0 | 1, minutesAfterStart: number, body: string, sender?: number, type?: string]
  const threads: { number: number; phone: string; name: string; assignee: number | null; daysAgo: number; lines: Line[] }[] = [
    { number: sales, phone: '85261112222', name: 'Mandy Wong', assignee: karen, daysAgo: 0, lines: [
      [0, 0, '你好，想問下嗰款智能門鎖仲有冇貨？'],
      [1, 4, 'Hi Mandy 😊 有貨呀！黑色同銀色都有，你想要邊隻顏色呀？', karen],
      [0, 9, '黑色，可唔可以星期六送貨？'],
      [1, 12, '可以呀！星期六下晝 2-6 點送到，我幫你book定喎 😊', karen],
      [0, 30, '好呀，咁幾錢？包唔包安裝？'],
    ] },
    { number: sales, phone: '85262223333', name: 'Jason Lee', assignee: ho, daysAgo: 0, lines: [
      [0, 0, 'Hi, can I get a quote for 20 units for our office?'],
      [1, 6, 'Sure Jason. 20 units 有 bulk discount, send 份 quotation 俾你 today.', ho],
      [0, 50, 'Great, also need installation for 2 floors'],
    ] },
    { number: service, phone: '85263334444', name: '陳生', assignee: null, daysAgo: 0, lines: [
      [0, 0, '部機今朝開始唔識連 wifi，點算？'],
      [0, 2, '', undefined, 'image'],
    ] },
    { number: service, phone: '85264445555', name: 'Ivy Chan', assignee: maggie, daysAgo: 1, lines: [
      [0, 0, '請問保養期係幾耐？'],
      [1, 15, '您好，所有產品均享有兩年原廠保養，如有需要歡迎隨時聯絡我們。', maggie],
      [0, 20, '明白，唔該晒！'],
      [1, 22, '不客氣，祝您生活愉快。', maggie],
    ] },
    { number: sales, phone: '85265556666', name: 'Tommy Ho', assignee: wai, daysAgo: 2, lines: [
      [0, 0, '上次你講嘅套裝價仲有冇效？'],
      [1, 40, '有效到月尾，我幫你留定', wai],
      [0, 45, '好，我同老婆傾吓先'],
    ] },
    { number: sales, phone: '85266667777', name: 'Cathy Lam', assignee: karen, daysAgo: 3, lines: [
      [0, 0, '我想訂兩套，可以月結嗎？'],
      [1, 8, '可以呀 Cathy！公司客戶可以月結，我send張表格俾你填呀 😊', karen],
      [0, 60, '填好了，請查收'],
      [1, 65, '收到喎，多謝晒！今個星期內出貨 🙌', karen],
    ] },
    { number: service, phone: '85261112222', name: 'Mandy Wong', assignee: maggie, daysAgo: 6, lines: [
      [0, 0, '之前買嘅門鐘冇聲，點處理？'],
      [1, 25, '您好，請嘗試長按重設鍵十秒，若仍未能解決，我們可安排上門檢查。', maggie],
      [0, 40, '得咗，多謝！'],
    ] },
    { number: sales, phone: '85267778888', name: 'Peter Cheung', assignee: ho, daysAgo: 9, lines: [
      [0, 0, 'Do you deliver to Tung Chung?'],
      [1, 3, 'Yes we do, free delivery 滿 $800', ho],
    ] },
  ]

  const conversationIds: number[] = []
  for (const t of threads) {
    const start = now - t.daysAgo * DAY - 3 * 3600
    t.lines.forEach(([fromMe, minutes, body, sender, type], i) => {
      const stored = storeMessage({
        numberId: t.number, jid: `${t.phone}@s.whatsapp.net`, contact: { pn: t.phone }, waName: t.name,
        waId: `seed-${t.number}-${t.phone}-${i}`, fromMe: Boolean(fromMe), senderId: sender ?? null,
        type: (type as any) ?? 'text', body, ts: Math.min(start + minutes * 60, now - 60), live: true,
      })
      if (stored && i === 0) conversationIds.push(stored.conversationId)
    })
  }
  conversationIds.forEach((id, i) => {
    const assignee = threads[i].assignee
    if (assignee) run('UPDATE conversations SET assignee_id = ? WHERE id = ?', assignee, id)
    if (threads[i].daysAgo > 1) run('UPDATE conversations SET unread = 0 WHERE id = ?', id)
  })
  run("UPDATE conversations SET status = 'closed', unread = 0 WHERE id = ?", conversationIds[7])

  run("UPDATE contacts SET name = 'Mandy Wong 黃小姐', owner_id = ?, notes = 'VIP，住將軍澳，偏好星期六送貨' WHERE phone = '85261112222'", karen)
  run("UPDATE contacts SET owner_id = ?, notes = 'ABC Trading 採購' WHERE phone = '85262223333'", ho)
  run("UPDATE contacts SET owner_id = ? WHERE phone = '85265556666'", wai)

  const contactId = (phone: string) => get<{ id: number }>('SELECT id FROM contacts WHERE phone = ?', phone)!.id
  const deal = (phone: string, conv: number, user: number, title: string, amount: number, stage: string, daysAgo: number) =>
    run('INSERT INTO deals (contact_id, conversation_id, user_id, title, amount, stage, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      contactId(phone), conv, user, title, amount, stage, now - daysAgo * DAY, stage === 'open' ? null : now - daysAgo * DAY + 3600)
  deal('85266667777', conversationIds[5], karen, '智能門鎖 x2（月結）', 7600, 'won', 3)
  deal('85261112222', conversationIds[0], karen, '智能門鎖 黑色', 3280, 'open', 0)
  deal('85262223333', conversationIds[1], ho, 'ABC Trading 辦公室 20 套', 52000, 'open', 0)
  deal('85267778888', conversationIds[7], ho, '門鐘套裝', 1180, 'won', 9)
  deal('85265556666', conversationIds[4], wai, '家居套裝', 4500, 'open', 2)

  addEvent(conversationIds[0], ho, 'handoff', 'Mandy 係熟客，Karen 跟開佢，交俾你啦', karen)
  addEvent(conversationIds[0], karen, 'note', '記得問佢要唔要加購門鐘')
})

console.log('Demo data created. Log in with karen@baton.demo / baton-demo')
