/**
 * "Comment a keyword, get a DM" for Instagram and Facebook: when someone comments on the
 * business's post with a keyword from a rule (e.g. "PILATES"), they get the rule's message
 * as a private reply, and optionally a public answer under their comment. Their reply lands
 * in the inbox, where the AI and the team carry on the conversation.
 */
import { all, get, run } from './db.js'
import { storeMessage } from './inbox.js'
import {
  metaEvents, replyToFacebookComment, replyToInstagramComment, sendFacebookPrivateReply, sendInstagramPrivateReply,
} from './meta.js'
import { broadcast } from './realtime.js'

interface Comment { id: string; text?: string; from?: { id?: string; username?: string } }
interface CommentEvent { platform: 'instagram' | 'facebook'; numberId: number; ownId: string; comment: Comment }

export function matchRule(numberId: number, text: string) {
  const lower = text.toLowerCase()
  return all<{ id: number; keywords: string; reply: string; public_reply: string }>(
    'SELECT id, keywords, reply, public_reply FROM ig_rules WHERE active = 1 AND (number_id IS NULL OR number_id = ?) ORDER BY id',
    numberId,
  ).find((r) => r.keywords.split(/[,，、]/).map((k) => k.trim().toLowerCase()).some((k) => k && lower.includes(k)))
}

async function handleComment({ platform, numberId, ownId, comment }: CommentEvent) {
  // Our own replies under comments come back as comments too.
  if (!comment.id || comment.from?.id === ownId) return
  if (get('SELECT 1 FROM ig_comments WHERE comment_id = ?', comment.id)) return
  const rule = matchRule(numberId, comment.text ?? '')
  run('INSERT INTO ig_comments (comment_id, number_id, rule_id, from_id, username, text) VALUES (?, ?, ?, ?, ?, ?)',
    comment.id, numberId, rule?.id ?? null, comment.from?.id ?? null, comment.from?.username ?? null, comment.text ?? '')
  if (!rule) return
  const instagram = platform === 'instagram'
  try {
    const sent = await (instagram ? sendInstagramPrivateReply : sendFacebookPrivateReply)(numberId, comment.id, rule.reply)
    run("UPDATE ig_comments SET status = 'sent' WHERE comment_id = ?", comment.id)
    run('UPDATE ig_rules SET hits = hits + 1 WHERE id = ?', rule.id)
    const customer = sent.recipient_id ?? comment.from?.id
    if (customer && sent.message_id) {
      storeMessage({
        numberId, jid: `${customer}@${instagram ? 'instagram' : 'messenger'}`, contact: instagram ? { ig: customer } : { fb: customer },
        waName: comment.from?.username ? (instagram ? `@${comment.from.username}` : comment.from.username) : undefined,
        waId: sent.message_id, fromMe: true, aiAuto: true, type: 'text', body: rule.reply,
        ts: Math.floor(Date.now() / 1000), live: true,
      })
    }
    if (rule.public_reply) {
      await (instagram ? replyToInstagramComment : replyToFacebookComment)(numberId, comment.id, rule.public_reply)
        .catch((err) => console.warn('Public comment reply failed', err))
    }
  } catch (err) {
    run("UPDATE ig_comments SET status = 'failed', error = ? WHERE comment_id = ?", err instanceof Error ? err.message : '發送失敗', comment.id)
  }
  broadcast('ig-comment', {})
}

metaEvents.on('comment', (e: CommentEvent) => { handleComment(e).catch((err) => console.error('Comment handling failed', err)) })
