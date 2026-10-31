/**
 * Automatic replies, per number:
 * - 'suggest': the AI prepares a reply for a teammate to send with one click.
 * - 'auto': the AI replies to the customer itself, and hands the conversation to the team
 *   when the knowledge base doesn't cover the question. Once a person replies, the AI stays
 *   quiet in that conversation until someone resumes it or the conversation is closed.
 */
import { customerReply, matchFaq, type CustomerReply } from './ai.js'
import { sendReply } from './channels.js'
import { all, get, getSetting, run } from './db.js'
import { addEvent, getConversation, inboxEvents, previewOf, type MessageType } from './inbox.js'
import { broadcast } from './realtime.js'

export type ReplyMode = 'off' | 'suggest' | 'auto'

/** Customers often send several short messages in a row; answer once they pause. */
const DELAY_MS = Number(process.env.BATON_AI_DELAY_MS ?? 8000)
/** Safety net against loops with another bot: at most this many AI replies per conversation per hour. */
const MAX_AUTO_PER_HOUR = 15

const timers = new Map<number, NodeJS.Timeout>()

interface MessageEvent { conversationId: number; numberId: number; messageId: number }

function replyMode(numberId: number): ReplyMode {
  return (get<{ reply_mode: ReplyMode }>('SELECT reply_mode FROM numbers WHERE id = ?', numberId)?.reply_mode ?? 'off')
}

inboxEvents.on('customer-message', ({ conversationId, numberId }: MessageEvent) => {
  if (replyMode(numberId) === 'off') return
  clearTimeout(timers.get(conversationId))
  timers.set(conversationId, setTimeout(() => {
    timers.delete(conversationId)
    respond(conversationId).catch((err) => {
      console.error('Auto-reply failed', err)
      addEvent(conversationId, null, 'ai_error', err instanceof Error ? err.message : 'AI 回覆失敗')
    })
  }, DELAY_MS))
})

inboxEvents.on('team-message', ({ conversationId, numberId, messageId }: MessageEvent) => {
  // Wait briefly: an Instagram echo of the AI's own message can arrive before it is credited to the AI.
  setTimeout(() => {
    const m = get<{ ai_auto: number }>('SELECT ai_auto FROM messages WHERE id = ?', messageId)
    if (!m || m.ai_auto) return
    clearTimeout(timers.get(conversationId))
    timers.delete(conversationId)
    const c = get<{ ai_paused: number; ai_suggestion: string | null; needs_human: number }>(
      'SELECT ai_paused, ai_suggestion, needs_human FROM conversations WHERE id = ?', conversationId,
    )
    if (!c) return
    const pause = replyMode(numberId) === 'auto' && !c.ai_paused
    if (!pause && c.ai_suggestion === null && !c.needs_human) return
    // A person answered: the suggestion is stale and the conversation leaves the "待人工" queue.
    run('UPDATE conversations SET ai_suggestion = NULL, needs_human = 0, ai_paused = CASE WHEN ? THEN 1 ELSE ai_paused END WHERE id = ?', pause ? 1 : 0, conversationId)
    if (pause) addEvent(conversationId, null, 'ai_paused', '同事已接手')
    broadcast('conversation', getConversation(conversationId))
  }, 3000)
})

async function respond(conversationId: number) {
  const conversation = getConversation(conversationId)
  if (!conversation || conversation.status === 'closed') return
  const mode = replyMode(conversation.number_id)
  if (mode === 'off' || (mode === 'auto' && conversation.ai_paused)) return

  // Everything the customer said since the team last replied.
  const recent = all<{ id: number; from_me: number; type: MessageType; body: string }>(
    'SELECT id, from_me, type, body FROM messages WHERE conversation_id = ? ORDER BY ts DESC, id DESC LIMIT 20', conversationId,
  )
  const pending = recent.slice(0, recent.findIndex((m) => m.from_me) === -1 ? recent.length : recent.findIndex((m) => m.from_me))
  if (pending.length === 0) return
  const latestId = pending[0].id

  let reply: CustomerReply
  const nonText = pending.find((m) => m.type !== 'text')
  const recentAuto = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND ai_auto = 1 AND ts > unixepoch() - 3600', conversationId,
  )!.c
  if (nonText) {
    // The AI reads text only; photos, voice notes and files need a person.
    reply = { action: 'handoff', reason: `客人傳送了${previewOf(nonText.type, '').trim() || '非文字訊息'}` }
  } else if (recentAuto >= MAX_AUTO_PER_HOUR) {
    reply = { action: 'handoff', reason: '一小時內自動回覆次數已達上限' }
  } else {
    // An exact FAQ answer only fits when it's what the latest message asks; anything else goes to the AI.
    const faq = matchFaq(pending[0].body)
    reply = faq ? { action: 'reply', text: faq.body } : await customerReply(conversationId)
  }

  // A teammate may have answered, or another customer message arrived, while the AI was thinking.
  const now = get<{ ai_paused: number; latest: number }>(
    'SELECT c.ai_paused, (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY ts DESC, id DESC LIMIT 1) AS latest FROM conversations c WHERE c.id = ?',
    conversationId,
  )
  if (!now || now.latest !== latestId || (mode === 'auto' && now.ai_paused)) return

  if (mode === 'suggest') {
    run('UPDATE conversations SET ai_suggestion = ?, needs_human = ? WHERE id = ?',
      reply.action === 'reply' ? reply.text : null, reply.action === 'handoff' ? 1 : 0, conversationId)
    if (reply.action === 'handoff') addEvent(conversationId, null, 'ai_handoff', reply.reason)
  } else if (reply.action === 'reply') {
    await sendReply(conversationId, reply.text, { userId: null, aiAuto: true })
  } else {
    run('UPDATE conversations SET ai_paused = 1, needs_human = 1 WHERE id = ?', conversationId)
    addEvent(conversationId, null, 'ai_handoff', reply.reason)
    const holding = getSetting('handoff_message').trim()
    if (holding) await sendReply(conversationId, holding, { userId: null, aiAuto: true })
  }
  broadcast('conversation', getConversation(conversationId))
}
