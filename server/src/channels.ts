/** Sending a reply, whichever way the number is connected. */
import { get, run } from './db.js'
import { getConversation, storeMessage } from './inbox.js'
import { sendCloudText, sendInstagramText } from './meta.js'
import { isConnected, sendText } from './whatsapp.js'

export type Channel = 'wa_web' | 'wa_cloud' | 'instagram'

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
  const contact = conversation.channel === 'instagram' ? { ig: conversation.jid.split('@')[0] } : { pn: conversation.phone ?? conversation.jid.split('@')[0] }

  if (number.demo) {
    storeMessage({ ...message, contact, waId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
  } else if (number.channel === 'wa_web') {
    await sendText(conversation.number_id, conversation.jid, text, opts.userId, message.aiAssisted, message.aiAuto)
  } else {
    const send = number.channel === 'wa_cloud' ? sendCloudText : sendInstagramText
    const waId = await send(conversation.number_id, conversationId, conversation.jid, text)
    // Instagram may deliver the echo of this message before we get here; credit the sender either way.
    if (!storeMessage({ ...message, contact, waId })) {
      run('UPDATE messages SET sender_id = ?, ai_assisted = ?, ai_auto = ? WHERE conversation_id = ? AND wa_id = ?',
        opts.userId, message.aiAssisted || message.aiAuto ? 1 : 0, message.aiAuto ? 1 : 0, conversationId, waId)
    }
  }
}
