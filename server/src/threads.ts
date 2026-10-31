/**
 * Threads: there is no direct-message API, so Baton handles replies under the business's
 * own posts. Every few minutes it reads the replies to posts from the last 7 days; each
 * person who replies becomes a conversation in the inbox, and answering it posts a public
 * reply under their latest reply. Uses the Threads API (graph.threads.net) with a long-lived
 * token holding threads_basic, threads_content_publish, threads_read_replies and
 * threads_manage_replies.
 */
import { all, get, setSetting } from './db.js'
import { storeMessage } from './inbox.js'
import { numberConfig } from './meta.js'

const TH = `https://graph.threads.net/${process.env.THREADS_API_VERSION ?? 'v1.0'}`
const POLL_MS = Number(process.env.BATON_THREADS_POLL_MS ?? 180_000)
/** Threads posts and replies are limited to 500 characters. */
const MAX_LENGTH = 500

export interface ThreadsConfig { userId: string; username: string; accessToken: string }

async function threads<T>(path: string, token: string, init: { method?: string; params?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`${TH}${path}`)
  const body = init.method === 'POST' ? new URLSearchParams(init.params) : undefined
  if (!body) for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}` }, body })
  const data = await res.json().catch(() => ({})) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Threads API 錯誤：${data.error?.message ?? res.status}`)
  return data
}

export async function verifyThreads(accessToken: string) {
  const me = await threads<{ id?: string; username?: string }>('/me', accessToken, { params: { fields: 'id,username' } })
  if (!me.id) throw new Error('未能讀取 Threads 帳戶')
  return { userId: String(me.id), username: me.username ?? '' }
}

/** Post a public reply under the customer's latest reply in this conversation. */
export async function sendThreadsReply(numberId: number, conversationId: number, text: string) {
  if ([...text].length > MAX_LENGTH) throw new Error(`Threads 回覆最多 ${MAX_LENGTH} 字`)
  const target = get<{ wa_id: string }>(
    'SELECT wa_id FROM messages WHERE conversation_id = ? AND from_me = 0 ORDER BY ts DESC, id DESC LIMIT 1', conversationId,
  )
  if (!target) throw new Error('找不到要回覆的留言')
  const { accessToken } = numberConfig<ThreadsConfig>(numberId)
  const container = await threads<{ id: string }>('/me/threads', accessToken, {
    method: 'POST', params: { media_type: 'TEXT', text, reply_to_id: target.wa_id },
  })
  // The container is sometimes not ready the instant it is created; try once more after a pause.
  try {
    return (await threads<{ id: string }>('/me/threads_publish', accessToken, { method: 'POST', params: { creation_id: container.id } })).id
  } catch {
    await new Promise((r) => setTimeout(r, 3000))
    return (await threads<{ id: string }>('/me/threads_publish', accessToken, { method: 'POST', params: { creation_id: container.id } })).id
  }
}

interface Reply { id: string; text?: string; username?: string; timestamp: string; is_reply_owned_by_me?: boolean }

async function pollNumber(numberId: number) {
  const { accessToken } = numberConfig<ThreadsConfig>(numberId)
  const since = Date.now() - 7 * 86400_000
  const posts = await threads<{ data?: { id: string; timestamp: string }[] }>('/me/threads', accessToken, { params: { fields: 'id,timestamp', limit: '20' } })
  for (const post of (posts.data ?? []).filter((p) => Date.parse(p.timestamp) > since)) {
    const replies = await threads<{ data?: Reply[] }>(`/${encodeURIComponent(post.id)}/conversation`, accessToken, {
      params: { fields: 'id,text,username,timestamp,is_reply_owned_by_me', limit: '100' },
    })
    for (const r of replies.data ?? []) {
      if (!r.username || r.is_reply_owned_by_me) continue
      const ts = Math.floor(Date.parse(r.timestamp) / 1000)
      storeMessage({
        numberId, jid: `${r.username}@threads`, contact: { th: r.username }, waName: `@${r.username}`,
        waId: r.id, fromMe: false, type: 'text', body: r.text ?? '', ts,
        // Older replies found on the first read are history: no unread badge, no automatic reply.
        live: Date.now() / 1000 - ts < 1800,
      })
    }
  }
}

export function startThreadsPolling() {
  const poll = () => {
    for (const n of all<{ id: number }>("SELECT id FROM numbers WHERE channel = 'threads' AND status = 'connected'")) {
      pollNumber(n.id).then(() => setSetting('webhook_last_threads', String(Math.floor(Date.now() / 1000)))).catch((err) => console.warn('Threads polling failed', err instanceof Error ? err.message : err))
    }
  }
  setTimeout(poll, 10_000)
  setInterval(poll, POLL_MS)
}
