/**
 * AI reply drafts in each teammate's own voice. The "voice" is learned from the
 * replies that teammate actually sent through Baton, plus optional notes they write
 * about how they like to sound.
 */
import Anthropic from '@anthropic-ai/sdk'
import { all, get } from './db.js'

const MODEL = process.env.BATON_AI_MODEL ?? 'claude-opus-5-5'
let client: Anthropic | undefined

function anthropic() {
  client ??= new Anthropic()
  return client
}

const SYSTEM = `You draft WhatsApp replies for a member of a small business's sales and service team.
The draft is shown to the teammate in a shared inbox; they review and edit it before sending, so write only the message itself, with no preamble, quotes or sign-off notes.

Write like the teammate, not like a bot:
- Match their language and register. Many customers write in Cantonese, Traditional Chinese, English, or a mix; reply in whatever the customer last used, the way the teammate would.
- Match their typical length, punctuation, emoji use and greetings, as shown in their past replies.
- Keep it short and natural for WhatsApp. One message, usually one to three sentences.
- Never invent prices, stock levels, dates or policies that are not in the conversation. If the customer needs a fact you don't have, write a reply that says the teammate will check, in their voice.`

export class AiUnavailableError extends Error {}

export async function draftReply(conversationId: number, userId: number, instruction?: string): Promise<string> {
  const user = get<{ name: string; style_notes: string }>('SELECT name, style_notes FROM users WHERE id = ?', userId)
  if (!user) throw new Error('找不到使用者')

  // The teammate's own recent replies, across every conversation, are the style examples.
  const examples = all<{ body: string }>(
    `SELECT body FROM messages
     WHERE sender_id = ? AND from_me = 1 AND type = 'text' AND length(body) >= 4
     ORDER BY ts DESC LIMIT 40`,
    userId,
  ).map((r) => r.body)

  const conversation = get<{ contact_name: string; number_label: string }>(
    `SELECT COALESCE(ct.name, ct.wa_name, ct.phone) AS contact_name, n.label AS number_label
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN numbers n ON n.id = c.number_id
     WHERE c.id = ?`,
    conversationId,
  )
  const history = all<{ from_me: number; type: string; body: string; sender_name: string | null }>(
    `SELECT m.from_me, m.type, m.body, u.name AS sender_name
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.ts DESC LIMIT 30`,
    conversationId,
  ).reverse()
  if (history.length === 0) throw new Error('對話未有訊息')

  const transcript = history
    .map((m) => {
      const who = m.from_me ? `Team (${m.sender_name ?? 'from phone'})` : 'Customer'
      const text = m.body || `[${m.type}]`
      return `${who}: ${text}`
    })
    .join('\n')

  const voice = [
    `Teammate: ${user.name}`,
    user.style_notes ? `How ${user.name} describes their own style: ${user.style_notes}` : '',
    examples.length
      ? `Real replies ${user.name} has sent to customers (most recent first):\n${examples.map((e) => `- ${e}`).join('\n')}`
      : `${user.name} has no sent replies yet, so use a warm, concise, professional tone.`,
  ].filter(Boolean).join('\n\n')

  const request = [
    `<conversation number="${conversation?.number_label ?? ''}" customer="${conversation?.contact_name ?? ''}">\n${transcript}\n</conversation>`,
    instruction ? `The teammate's instruction for this draft: ${instruction}` : '',
    `Draft ${user.name}'s next reply.`,
  ].filter(Boolean).join('\n\n')

  let response
  try {
    response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: SYSTEM },
        // The voice block changes per teammate but is stable across their drafts, so cache it.
        { type: 'text', text: voice, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: request }],
    })
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || (err instanceof Error && /API key|credentials|authentication/i.test(err.message))) {
      throw new AiUnavailableError('未設定 ANTHROPIC_API_KEY，AI 草擬暫不可用')
    }
    throw err
  }

  if (response.stop_reason === 'refusal') throw new Error('AI 未能草擬此回覆，請手動回覆')
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) throw new Error('AI 未有產生內容')
  return text
}
