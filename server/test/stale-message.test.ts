/** A customer message delivered long after it was sent (Baton offline) goes to a person, not the AI. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, inbox, fitness } = t

test('a message sent 3 hours ago is handed off without an AI reply', async () => {
  const s = inbox.storeMessage({
    numberId: fitness, jid: '85291234500@s.whatsapp.net', contact: { pn: '85291234500' }, waId: 'late-1',
    fromMe: false, type: 'text', body: '今晚有冇位？', ts: Math.floor(Date.now() / 1000) - 3 * 3600, live: true,
  })!
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND from_me = 1', s.conversationId)!.c, 0)
  assert.equal(db.get<{ needs_human: number }>('SELECT needs_human FROM conversations WHERE id = ?', s.conversationId)!.needs_human, 1)
})
