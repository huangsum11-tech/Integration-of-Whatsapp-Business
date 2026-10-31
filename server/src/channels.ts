/** Sending a reply, whichever way the number is connected. */
import { get, run } from './db.js'
import { getConversation, storeMessage } from './inbox.js'
import { sendCloudTemplate, sendCloudText, sendInstagramText, sendMessengerText, type TemplateMessage } from './meta.js'
import { sendThreadsReply } from './threads.js'
import { isConnected, sendText } from './whatsapp.js'

export type Channel = 'wa_web' | 'wa_cloud' | 'instagram' | 'messenger' | 'threads'

/** Who the customer is, from the conversation's address ("<id>@instagram", "<psid>@messenger", "<user>@threads", or a WhatsApp JID). */
function contactFor(jid: string, phone: string | null) {
  const [id, domain] = jid.split('@')
  if (domain === 'instagram') return { ig: id }
  if (domain === 'messenger') return { fb: id }
  if (domain === 'threads') return { th: id }
  return { pn: phone ?? id }
}

export function canSend(numberId: number) {
  const n = get<{ demo: number; channel: Channel; status: string }>('SELECT demo, channel, status FROM numbers WHERE id = ?', numberId)
  if (!n) return false
  if (n.demo) return true
  return n.channel === 'wa_web' ? isConnected(numberId) : n.status === 'connected'
}

export interface SendOptions {
  /** The teammate sending, or null when the AI replies on its own. */
  userId: number | null
  aiAssisted?: boolean
  aiAuto?: boolean
}

export async function sendReply(conversationId: number, text: string, opts: SendOptions) {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('找不到對話')
  const number = get<{ demo: number; channel: Channel }>('SELECT demo, channel FROM numbers WHERE id = ?', conversation.number_id)
  if (!number) throw new Error('找不到號碼')
  const message = {
    numberId: conversation.number_id, jid: conversation.jid, fromMe: true, senderId: opts.userId,
    aiAssisted: opts.aiAssisted ?? false, aiAuto: opts.aiAuto ?? false, type: 'text' as const, body: text,
    ts: Math.floor(Date.now() / 1000), live: true,
  }
  const contact = contactFor(conversation.jid, conversation.phone)

  if (number.demo) {
    storeMessage({ ...message, contact, waId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
  } else if (number.channel === 'wa_web') {
    await sendText(conversation.number_id, conversation.jid, text, opts.userId, message.aiAssisted, message.aiAuto)
  } else {
    const waId = number.channel === 'threads'
      ? await sendThreadsReply(conversation.number_id, conversationId, text)
      : await ({ wa_cloud: sendCloudText, instagram: sendInstagramText, messenger: sendMessengerText } as const)[number.channel](
        conversation.number_id, conversationId, conversation.jid, text,
      )
    // Instagram may deliver the echo of this message before we get here; credit the sender either way.
    if (!storeMessage({ ...message, contact, waId })) {
      run('UPDATE messages SET sender_id = ?, ai_assisted = ?, ai_auto = ? WHERE conversation_id = ? AND wa_id = ?',
        opts.userId, message.aiAssisted || message.aiAuto ? 1 : 0, message.aiAuto ? 1 : 0, conversationId, waId)
    }
  }
}

/** HK numbers are often written with 8 digits only; WhatsApp needs the country code. */
export function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 8 ? `852${digits}` : digits
}

/**
 * Start (or continue) a chat with any phone number, e.g. an instructor's payslip.
 * The WhatsApp Cloud API only allows this with an approved template; the text is what the
 * team sees in the inbox.
 */
export async function sendToPhone(numberId: number, phone: string, text: string, opts: { userId: number | null; template?: TemplateMessage }) {
  const number = get<{ demo: number; channel: Channel; status: string }>('SELECT demo, channel, status FROM numbers WHERE id = ?', numberId)
  if (!number) throw new Error('找不到發送號碼')
  const pn = normalizePhone(phone)
  if (pn.length < 8) throw new Error('電話號碼不正確')
  const jid = `${pn}@s.whatsapp.net`
  const message = {
    numberId, jid, contact: { pn }, fromMe: true, senderId: opts.userId, type: 'text' as const, body: text,
    ts: Math.floor(Date.now() / 1000), live: true,
  }
  if (number.demo) {
    const waId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    storeMessage({ ...message, waId })
    return waId
  } else if (number.channel === 'wa_web') {
    return await sendText(numberId, jid, text, opts.userId, false)
  } else if (number.channel === 'wa_cloud') {
    if (!opts.template?.name) throw new Error('官方 Cloud API 主動發訊息需要已審批的模板，請在設定填寫模板名稱')
    if (number.status !== 'connected') throw new Error('此號碼未連接')
    const waId = await sendCloudTemplate(numberId, pn, opts.template)
    storeMessage({ ...message, waId })
    return waId
  } else {
    throw new Error('Instagram／Facebook／Threads 不能主動發訊息給電話號碼，請選 WhatsApp 號碼')
  }
}
