/**
 * Automatic replies, per number:
 * - 'suggest': the AI prepares a reply for a teammate to send with one click.
 * - 'auto': the AI replies to the customer itself, and hands the conversation to the team
 *   when the knowledge base doesn't cover the question. Once a person replies, the AI stays
 *   quiet in that conversation until someone resumes it or the conversation is closed.
 */
import { customerReply, findFaq, type CustomerReply } from './ai.js'
import { recordTrial } from './automation.js'
import { sendReply } from './channels.js'
import { all, get, getSetting, run } from './db.js'
import { addEvent, getConversation, inboxEvents, previewOf, type MessageType } from './inbox.js'
import { broadcast } from './realtime.js'
import { canTranscribe } from './transcribe.js'
import { activeFlow, endFlow, handleFlows, sensitiveTopic, type FlowReply } from './flows.js'
import { HUMAN_BUTTON } from './meta.js'
import { brandOfConversation } from './brands.js'
import { sendImage } from './channels.js'

export type ReplyMode = 'off' | 'suggest' | 'auto'

/** Customers often send several short messages in a row; answer once they pause. */
const DELAY_MS = Number(process.env.BATON_AI_DELAY_MS ?? 8000)
/** Safety net against loops with another bot: at most this many AI replies per conversation per hour. */
const MAX_AUTO_PER_HOUR = 15

const timers = new Map<number, NodeJS.Timeout>()

/** Sent when the customer asks for a person and no handoff message is set. */
const DEFAULT_HANDOFF = '收到！我已經通知同事，佢哋會盡快回覆你 🙏'

/**
 * The customer tapped 「同真人講」 or typed exactly those four characters. A sentence that only
 * contains them ("我唔想同真人講") is an ordinary message for the AI.
 */
export function isHumanRequest(text: string) {
  return text.replace(/\s+/g, '').replace(/[!！。.~～?？]+$/u, '') === HUMAN_BUTTON.title
}

/**
 * Hand the conversation to the team at the customer's request: same state as the AI's own
 * handoff, any guided flow stops, and the customer is told once (without the button). A request
 * while the conversation is already waiting for a person changes nothing.
 */
export async function requestHuman(conversationId: number) {
  const c = get<{ ai_paused: number; needs_human: number; number_id: number }>(
    'SELECT ai_paused, needs_human, number_id FROM conversations WHERE id = ?', conversationId,
  )
  if (!c || (c.ai_paused && c.needs_human)) return false
  clearTimeout(timers.get(conversationId))
  timers.delete(conversationId)
  const flow = activeFlow(conversationId)
  if (flow) endFlow(flow.id, 'aborted', '客人要求同真人講')
  run('UPDATE conversations SET needs_human = 1, ai_paused = 1, ai_suggestion = NULL WHERE id = ?', conversationId)
  addEvent(conversationId, null, 'ai_handoff', '客人要求同真人講')
  broadcast('conversation', getConversation(conversationId))
  // Only a number that answers on its own speaks to the customer; in 'suggest' mode the team replies.
  if (replyMode(c.number_id) === 'auto') {
    await sendReply(conversationId, getSetting('handoff_message').trim() || DEFAULT_HANDOFF, { userId: null, aiAuto: true })
  }
  return true
}

/** The customer asks for a person in their own words. */
const PERSON_REQUEST = /真人|搵人|人工|職員|staff|human|real person|打電話俾我|call me/i

/** Was the AI's last message to this customer its one clarifying question? */
function justClarified(conversationId: number) {
  const lastOut = get<{ ts: number; ai_auto: number; body: string }>(
    'SELECT ts, ai_auto, body FROM messages WHERE conversation_id = ? AND from_me = 1 ORDER BY ts DESC, id DESC LIMIT 1', conversationId,
  )
  const lastClarify = get<{ ts: number; body: string }>("SELECT ts, body FROM events WHERE conversation_id = ? AND kind = 'ai_clarify' ORDER BY id DESC LIMIT 1", conversationId)
  // Timestamps are in seconds, so also check that the last message really is that question.
  return Boolean(lastOut?.ai_auto && lastClarify && lastClarify.ts >= lastOut.ts && lastClarify.body === lastOut.body)
}

/**
 * Red lines for clarifying questions, enforced here rather than trusted to the prompt:
 * cases that must go to a person are never delayed by a question, and the AI asks at most once.
 */
export function guardClarify(conversationId: number, customerText: string, reply: CustomerReply): CustomerReply {
  if (reply.action !== 'reply' || !reply.clarify) return reply
  const topic = sensitiveTopic(customerText)
  if (topic) return { action: 'handoff', reason: `客人提及${topic}，需要同事處理` }
  if (PERSON_REQUEST.test(customerText)) return { action: 'handoff', reason: '客人要求真人' }
  if (justClarified(conversationId)) return { action: 'handoff', reason: '澄清後仍未清楚，需要同事處理' }
  return reply
}

/** The 「同真人講」 button is only on WhatsApp Cloud API numbers, so only they take the request. */
function takesHumanRequest(numberId: number, messageId: number) {
  const n = get<{ channel: string }>('SELECT channel FROM numbers WHERE id = ?', numberId)
  if (n?.channel !== 'wa_cloud') return false
  const m = get<{ type: string; body: string }>('SELECT type, body FROM messages WHERE id = ?', messageId)
  return m?.type === 'text' && isHumanRequest(m.body)
}

interface MessageEvent { conversationId: number; numberId: number; messageId: number }

function replyMode(numberId: number): ReplyMode {
  return (get<{ reply_mode: ReplyMode }>('SELECT reply_mode FROM numbers WHERE id = ?', numberId)?.reply_mode ?? 'off')
}

inboxEvents.on('customer-message', ({ conversationId, numberId, messageId }: MessageEvent) => {
  if (replyMode(numberId) === 'off') return
  if (takesHumanRequest(numberId, messageId)) {
    requestHuman(conversationId).catch((err) => {
      console.error('Handoff request failed', err)
      addEvent(conversationId, null, 'ai_error', err instanceof Error ? err.message : '轉交訊息發送失敗')
    })
    return
  }
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
  const load = () => {
    const recent = all<{ id: number; from_me: number; type: MessageType; body: string; transcript: string | null }>(
      'SELECT id, from_me, type, body, transcript FROM messages WHERE conversation_id = ? ORDER BY ts DESC, id DESC LIMIT 20', conversationId,
    )
    return recent.slice(0, recent.findIndex((m) => m.from_me) === -1 ? recent.length : recent.findIndex((m) => m.from_me))
  }
  let pending = load()
  if (pending.length === 0) return
  // Give voice notes up to 30 seconds to download and be transcribed, so the AI can answer them.
  const untranscribed = () => pending.some((m) => (m.type === 'voice' || m.type === 'audio') && !m.transcript)
  for (let i = 0; i < 10 && canTranscribe() && untranscribed(); i++) {
    await new Promise((r) => setTimeout(r, 3000))
    pending = load()
  }
  const latestId = pending[0].id

  let reply: FlowReply
  // Guided trial / purchase flows (and sensitive topics) come before FAQs and the AI.
  const outcome = handleFlows(conversationId, pending)
  // A question asked in the middle of a flow: answer it below, then ask the flow's question again.
  const aside = outcome?.action === 'aside' ? outcome : null
  const flowReply = outcome && outcome.action !== 'aside' ? outcome : null
  const nonText = pending.find((m) => m.type !== 'text' && !m.transcript)
  const recentAuto = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND ai_auto = 1 AND ts > unixepoch() - 3600', conversationId,
  )!.c
  if (flowReply) {
    reply = flowReply
  } else if (nonText) {
    // The AI reads text only; photos, voice notes and files need a person.
    reply = { action: 'handoff', reason: `客人傳送了${previewOf(nonText.type, '').trim() || '非文字訊息'}` }
  } else if (recentAuto >= MAX_AUTO_PER_HOUR) {
    reply = { action: 'handoff', reason: '一小時內自動回覆次數已達上限' }
  } else {
    // An exact FAQ answer only fits when it's what the latest message asks; anything else goes to the AI.
    const faq = findFaq(pending[0].transcript ?? pending[0].body, brandOfConversation(conversationId)?.id)
    reply = faq
      ? { action: 'reply', text: faq.body }
      : guardClarify(conversationId, pending.map((m) => m.transcript ?? m.body).join('\n'), await customerReply(conversationId, aside ? { resume: aside.resume } : undefined))
  }

  // A teammate may have answered, or another customer message arrived, while the AI was thinking.
  const now = get<{ ai_paused: number; latest: number }>(
    'SELECT c.ai_paused, (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY ts DESC, id DESC LIMIT 1) AS latest FROM conversations c WHERE c.id = ?',
    conversationId,
  )
  if (!now || now.latest !== latestId || (mode === 'auto' && now.ai_paused)) return

  if (mode === 'suggest') {
    const suggestion = reply.action === 'reply' ? (aside ? `${reply.text}\n\n${aside.resume}` : reply.text) : null
    run('UPDATE conversations SET ai_suggestion = ?, needs_human = ? WHERE id = ?',
      suggestion, reply.action === 'handoff' ? 1 : 0, conversationId)
    if (reply.action === 'handoff') addEvent(conversationId, null, 'ai_handoff', reply.reason)
  } else if (reply.action === 'reply') {
    // FAQ answers and AI-written replies offer 「同真人講」; guided flow steps don't.
    await sendReply(conversationId, reply.text, { userId: null, aiAuto: true, humanButton: !flowReply })
    for (const image of reply.images ?? []) {
      await sendImage(conversationId, image, '', { userId: null, aiAuto: true }).catch((err) => console.warn('Image not sent', err))
    }
    // Remember the one clarifying question, so a second one in a row becomes a handoff.
    if (reply.clarify) addEvent(conversationId, null, 'ai_clarify', reply.text)
    // Back to the flow, as its own message (a flow message: no button) — unless the AI is
    // waiting for the answer to its clarifying question.
    if (aside && !reply.clarify) await sendReply(conversationId, aside.resume, { userId: null, aiAuto: true })
  } else {
    run('UPDATE conversations SET ai_paused = 1, needs_human = 1 WHERE id = ?', conversationId)
    addEvent(conversationId, null, 'ai_handoff', reply.reason)
    const holding = getSetting('handoff_message').trim()
    if (holding) await sendReply(conversationId, holding, { userId: null, aiAuto: true })
  }
  // Replied, but a teammate still has something to do (quote a discount, check a screenshot…).
  if (reply.action === 'reply' && reply.flagForTeam) {
    run('UPDATE conversations SET needs_human = 1 WHERE id = ?', conversationId)
    addEvent(conversationId, null, 'ai_handoff', reply.flagForTeam)
  }
  // The customer told the AI when their trial class is: remember it for the follow-up.
  if (reply.action === 'reply' && reply.trial) recordTrial(conversationId, reply.trial.at, reply.trial.className, 'ai', null)
  broadcast('conversation', getConversation(conversationId))
}
