/**
 * The setup checklist on the 號碼 page: what is done and what is left before the AI can
 * answer customers on every channel.
 */
import { automationSettings } from './automation.js'
import { all, get, getSetting } from './db.js'
import { PROVIDERS, currentAi, hasKey } from './llm.js'
import { canTranscribe } from './transcribe.js'

interface Check { id: string; label: string; ok: boolean; optional?: boolean; detail: string; page: string }

const CHANNELS = [
  { channel: 'wa_cloud', object: 'whatsapp_business_account', label: 'WhatsApp 官方 Cloud API' },
  { channel: 'instagram', object: 'instagram', label: 'Instagram' },
  { channel: 'messenger', object: 'page', label: 'Facebook Messenger' },
  { channel: 'threads', object: 'threads', label: 'Threads' },
] as const

function ago(ts: number) {
  const m = Math.round((Date.now() / 1000 - ts) / 60)
  return m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 日前`
}

export function setupStatus(): Check[] {
  const ai = currentAi()
  const knowledge = get<{ c: number; placeholders: number }>(
    "SELECT COUNT(*) AS c, SUM(instr(body, '[') > 0) AS placeholders FROM knowledge WHERE active = 1",
  )!
  const numbers = all<{ channel: string; status: string; reply_mode: string; label: string }>(
    "SELECT channel, status, reply_mode, label FROM numbers WHERE demo = 0",
  )
  const checks: Check[] = [
    {
      id: 'ai', label: 'AI 金鑰', ok: hasKey(ai.provider), page: 'ai',
      detail: hasKey(ai.provider) ? `使用 ${PROVIDERS[ai.provider].label}：${ai.model}` : `在 .env 填寫 ${PROVIDERS[ai.provider].keyEnv} 後重新啟動`,
    },
    {
      id: 'business', label: '公司資料', ok: Boolean(getSetting('business_name') && getSetting('business_intro')), page: 'ai',
      detail: '「AI 助手」→ 公司資料：名稱、簡介、地址、營業時間',
    },
    {
      id: 'knowledge', label: '知識庫', ok: knowledge.c >= 3 && !knowledge.placeholders, page: 'ai',
      detail: knowledge.c < 3 ? `只有 ${knowledge.c} 項，建議最少加入課程、價錢、取消政策`
        : knowledge.placeholders ? `${knowledge.placeholders} 項仍有 [方括號] 未填` : `${knowledge.c} 項資料`,
    },
    {
      id: 'booking', label: '試堂預約連結', ok: Boolean(getSetting('trial_booking_url')), page: 'ai',
      detail: '「AI 助手」→ 公司資料：AI 會把連結給第一次試堂的客人',
    },
    {
      id: 'secret', label: 'Webhook 安全設定', ok: Boolean(process.env.META_VERIFY_TOKEN && (process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET)), page: 'numbers',
      detail: '在 .env 填寫 META_VERIFY_TOKEN 和 META_APP_SECRET',
    },
  ]
  for (const c of CHANNELS) {
    const connected = numbers.filter((n) => n.channel === c.channel && n.status === 'connected')
    const last = Number(getSetting(`webhook_last_${c.object}`)) || 0
    const optional = c.channel !== 'wa_cloud'
    checks.push({
      id: c.channel, label: c.label, ok: connected.length > 0 && last > 0, optional, page: 'numbers',
      detail: connected.length === 0 ? '未連接：「號碼」→ 連接新號碼或帳戶'
        : last === 0 ? (c.channel === 'threads' ? '已連接，等待第一次讀取留言' : '已連接，但未收過 Meta 的 webhook：檢查 Meta App 的 Webhooks 設定')
        : `已連接 ${connected.map((n) => `${n.label}（${({ off: 'AI 關閉', suggest: 'AI 建議', auto: '全自動' } as Record<string, string>)[n.reply_mode]}）`).join('、')}；最近收到訊息：${ago(last)}`,
    })
  }
  const notify = automationSettings().notify_number_id
  checks.push(
    {
      id: 'mode', label: 'AI 自動回覆已開啟', ok: numbers.some((n) => n.reply_mode !== 'off'), page: 'numbers',
      detail: '「號碼」頁每個帳戶選「AI 建議」或「全自動」（建議先用 AI 建議觀察）',
    },
    {
      id: 'notify', label: '通知用號碼', ok: Boolean(notify), optional: true, page: 'automation',
      detail: '「自動化」→ 通知用號碼：用來發等待提醒、每週報告給同事',
    },
    {
      id: 'voice', label: '語音轉文字', ok: canTranscribe(), optional: true, page: 'automation',
      detail: canTranscribe() ? '已啟用（Gemini）' : '在 .env 填寫 GEMINI_API_KEY 即可啟用',
    },
  )
  return checks
}
