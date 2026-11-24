/**
 * Official Meta APIs: the WhatsApp Business Cloud API, the Instagram Messaging API
 * (Instagram API with Instagram Login) and the Messenger Platform (Facebook Page). All
 * deliver customer messages to one webhook, /webhooks/meta, and send replies with an
 * access token stored on the number. (Threads has no messaging API; see threads.ts.)
 */
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { all, get, run, setSetting } from './db.js'
import { setMessageMedia, storeMessage, type MessageType } from './inbox.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR } from './whatsapp.js'

const VERSION = process.env.META_GRAPH_VERSION ?? 'v25.0'
const FB = `https://graph.facebook.com/${VERSION}`
const IG = `https://graph.instagram.com/${VERSION}`

export interface CloudConfig { phoneNumberId: string; accessToken: string }
/**
 * Instagram has two routes. 'instagram' (default, older configs): an IGAA token from
 * Instagram Login, used on graph.instagram.com and refreshed with ig_refresh_token.
 * 'facebook': an EAA token from the Facebook platform (user, Page or system-user token),
 * used on graph.facebook.com; when the account's Facebook Page is known, messages go
 * through the Page with the Page token.
 */
export type InstagramHost = 'instagram' | 'facebook'
export interface InstagramConfig {
  igUserId: string; accessToken: string; username?: string
  host?: InstagramHost; pageId?: string
  /** Facebook route: unix seconds when the stored token expires; 0 = never; absent = unknown. */
  expiresAt?: number; tokenType?: string
}
export interface MessengerConfig { pageId: string; accessToken: string; name?: string }

export function numberConfig<T>(numberId: number): T {
  const row = get<{ config: string }>('SELECT config FROM numbers WHERE id = ?', numberId)
  return JSON.parse(row?.config || '{}') as T
}

/** Which Graph host an Instagram token belongs to: EAA… tokens are Facebook-platform tokens. */
export function instagramHostFor(token: string): InstagramHost {
  return token.trim().startsWith('EAA') ? 'facebook' : 'instagram'
}
function igBase(config: Pick<InstagramConfig, 'host'>) {
  return config.host === 'facebook' ? FB : IG
}
/** The account that sends Instagram messages: the Page on the Facebook route when known. */
function igSender(config: InstagramConfig) {
  return config.host === 'facebook' && config.pageId ? config.pageId : config.igUserId
}

async function graph<T>(url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => ({})) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Meta API 錯誤：${data.error?.message ?? res.status}`)
  return data
}

// ---------- Connecting ----------

/** Check the Cloud API credentials and return the number's display phone. */
export async function verifyCloud(config: CloudConfig) {
  const info = await graph<{ display_phone_number?: string; verified_name?: string }>(
    `${FB}/${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name`, config.accessToken,
  )
  return { phone: info.display_phone_number?.replace(/\D/g, '') ?? null, name: info.verified_name ?? null }
}

/** Check an Instagram access token and return the professional account it belongs to. */
export async function verifyInstagram(accessToken: string, igUserId?: string): Promise<Omit<InstagramConfig, 'accessToken'> & { accessToken: string }> {
  if (instagramHostFor(accessToken) === 'facebook') return verifyInstagramFacebook(accessToken.trim(), igUserId?.trim() || undefined)
  const me = await graph<{ user_id?: string; id?: string; username?: string }>(`${IG}/me?fields=user_id,username`, accessToken)
  const id = me.user_id ?? me.id
  if (!id) throw new Error('未能讀取 Instagram 帳戶')
  return { igUserId: String(id), username: me.username ?? '', accessToken, host: 'instagram' }
}

type IgAccount = { id?: string; username?: string }
type PageRow = { id?: string; name?: string; access_token?: string; instagram_business_account?: IgAccount }

/**
 * Facebook-platform (EAA) token. Works with a user or system-user token that manages the
 * account's Page (the Page and its Page token are looked up), a Page token, or a token
 * scoped to the Instagram account itself (then the Instagram user ID is needed).
 */
async function verifyInstagramFacebook(token: string, wantedId?: string) {
  // 1. User / system-user token: find the Page linked to the Instagram account.
  const pages = await graph<{ data?: PageRow[] }>(
    `${FB}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100`, token,
  ).then((r) => r.data ?? []).catch(() => [] as PageRow[])
  const linked = pages.filter((p) => p.instagram_business_account?.id && (!wantedId || p.instagram_business_account.id === wantedId))
  if (linked.length > 1) throw new Error('呢個憑證管理多個 Instagram 帳戶，請填「Instagram 用戶 ID」')
  let found: { igUserId: string; username: string; pageId?: string; accessToken: string } | undefined
  if (linked.length === 1) {
    const p = linked[0]
    found = { igUserId: String(p.instagram_business_account!.id), username: p.instagram_business_account!.username ?? '', pageId: p.id, accessToken: p.access_token || token }
  }
  // 2. Page token: the Page itself carries the Instagram account.
  if (!found) {
    const me = await graph<PageRow>(`${FB}/me?fields=id,name,instagram_business_account{id,username}`, token).catch(() => null)
    const ig = me?.instagram_business_account
    if (ig?.id && (!wantedId || ig.id === wantedId)) found = { igUserId: String(ig.id), username: ig.username ?? '', pageId: me?.id, accessToken: token }
  }
  // 3. Token scoped to the Instagram account: read it by ID.
  if (!found && wantedId) {
    const acc = await graph<IgAccount>(`${FB}/${encodeURIComponent(wantedId)}?fields=id,username`, token)
    if (acc.id) found = { igUserId: String(acc.id), username: acc.username ?? '', accessToken: token }
  }
  if (!found) {
    throw new Error(wantedId ? '用呢個 Facebook 憑證讀唔到呢個 Instagram 帳戶' : '用呢個 Facebook 憑證搵唔到 Instagram 帳戶，請填「Instagram 用戶 ID」再試')
  }
  return { ...found, host: 'facebook' as const, ...(await tokenExpiry(found.accessToken)) }
}

/** Best effort: when the token expires (0 = never) and its type. Unknown when Meta won't say. */
async function tokenExpiry(token: string): Promise<{ expiresAt?: number; tokenType?: string }> {
  try {
    const r = await graph<{ data?: { expires_at?: number; data_access_expires_at?: number; type?: string; is_valid?: boolean } }>(
      `${FB}/debug_token?input_token=${encodeURIComponent(token)}`, token,
    )
    if (!r.data || r.data.is_valid === false) return {}
    return { expiresAt: Number(r.data.expires_at ?? 0), tokenType: r.data.type }
  } catch {
    return {}
  }
}

/** Check a Facebook Page access token and return the Page's name. */
export async function verifyMessenger(pageId: string, accessToken: string) {
  const page = await graph<{ id?: string; name?: string }>(`${FB}/${encodeURIComponent(pageId)}?fields=id,name`, accessToken)
  if (!page.id) throw new Error('未能讀取 Facebook 專頁')
  return { pageId: String(page.id), name: page.name ?? '' }
}

/**
 * Ask Meta to send this Page's / Instagram account's events to our app's webhook.
 * Best effort: it needs the right permissions, and can also be done in the App dashboard.
 */
export async function subscribeWebhooks(channel: string, config: Record<string, string>) {
  if (channel === 'messenger') {
    await graph(`${FB}/${encodeURIComponent(config.pageId)}/subscribed_apps`, config.accessToken, {
      method: 'POST', body: { subscribed_fields: 'messages,message_echoes,messaging_postbacks,feed' },
    })
  } else if (channel === 'instagram') {
    const ig = config as unknown as InstagramConfig
    try {
      await graph(`${igBase(ig)}/${encodeURIComponent(ig.igUserId)}/subscribed_apps`, ig.accessToken, {
        method: 'POST', body: { subscribed_fields: 'messages,comments' },
      })
    } catch (err) {
      // Facebook route: Instagram events can also be subscribed through the linked Page.
      if (ig.host !== 'facebook' || !ig.pageId) throw err
      await graph(`${FB}/${encodeURIComponent(ig.pageId)}/subscribed_apps`, ig.accessToken, {
        method: 'POST', body: { subscribed_fields: 'messages,feed' },
      })
    }
  }
}

// ---------- Sending ----------

/**
 * Both official APIs only allow free-form replies within 24 hours of the customer's last
 * message; after that, WhatsApp requires an approved template and Instagram refuses.
 */
function assertServiceWindow(conversationId: number) {
  const last = get<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM messages WHERE conversation_id = ? AND from_me = 0', conversationId)?.ts
  if (!last || Date.now() / 1000 - last > 24 * 3600) {
    throw new Error('已超過 24 小時客服窗口：官方 API 只容許在客人最後一次傳訊息後 24 小時內自由回覆')
  }
}

export async function sendCloudText(numberId: number, conversationId: number, jid: string, text: string) {
  assertServiceWindow(conversationId)
  const config = numberConfig<CloudConfig>(numberId)
  const data = await graph<{ messages?: { id: string }[] }>(`${FB}/${encodeURIComponent(config.phoneNumberId)}/messages`, config.accessToken, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: jid.split('@')[0], type: 'text', text: { body: text, preview_url: false } },
  })
  const id = data.messages?.[0]?.id
  if (!id) throw new Error('發送失敗')
  return id
}

/** The quick-reply button on the AI's WhatsApp replies that hands the chat to a person. */
export const HUMAN_BUTTON = { id: 'handoff_human', title: '👤 轉介同事跟進' } as const
/** The id used before 2026-11-13; buttons already in customers' chats still carry it. */
const LEGACY_HUMAN_BUTTON_IDS = new Set(['baton_human'])
/** WhatsApp's limit for the body of a message with reply buttons. */
export const BUTTON_BODY_MAX = 1024

/** Request body for a text message with quick-reply buttons (WhatsApp allows up to 3, titles up to 20 characters). */
export function cloudButtonPayload(to: string, text: string, buttons: readonly { id: string; title: string }[]) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  }
}

/** A reply with quick-reply buttons, within the 24-hour window like any free-form reply. */
export async function sendCloudButtons(numberId: number, conversationId: number, jid: string, text: string, buttons: readonly { id: string; title: string }[]) {
  assertServiceWindow(conversationId)
  const config = numberConfig<CloudConfig>(numberId)
  const data = await graph<{ messages?: { id: string }[] }>(`${FB}/${encodeURIComponent(config.phoneNumberId)}/messages`, config.accessToken, {
    method: 'POST', body: cloudButtonPayload(jid.split('@')[0], text, buttons),
  })
  const id = data.messages?.[0]?.id
  if (!id) throw new Error('發送失敗')
  return id
}

/** Upload an image to WhatsApp and send it (within the 24-hour window). */
export async function sendCloudImage(numberId: number, conversationId: number, jid: string, file: string, caption: string) {
  assertServiceWindow(conversationId)
  const config = numberConfig<CloudConfig>(numberId)
  const form = new FormData()
  const ext = path.extname(file).slice(1).toLowerCase()
  form.append('messaging_product', 'whatsapp')
  form.append('type', `image/${ext === 'jpg' ? 'jpeg' : ext}`)
  form.append('file', new Blob([fs.readFileSync(file)], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }), path.basename(file))
  const res = await fetch(`${FB}/${encodeURIComponent(config.phoneNumberId)}/media`, {
    method: 'POST', headers: { authorization: `Bearer ${config.accessToken}` }, body: form,
  })
  const media = await res.json().catch(() => ({})) as { id?: string; error?: { message?: string } }
  if (!res.ok || !media.id) throw new Error(`Meta API 錯誤：${media.error?.message ?? res.status}`)
  const data = await graph<{ messages?: { id: string }[] }>(`${FB}/${encodeURIComponent(config.phoneNumberId)}/messages`, config.accessToken, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: jid.split('@')[0], type: 'image', image: { id: media.id, caption } },
  })
  const id = data.messages?.[0]?.id
  if (!id) throw new Error('發送失敗')
  return id
}

export async function sendMessengerText(numberId: number, conversationId: number, jid: string, text: string) {
  assertServiceWindow(conversationId)
  const config = numberConfig<MessengerConfig>(numberId)
  const data = await graph<{ message_id?: string }>(`${FB}/${encodeURIComponent(config.pageId)}/messages`, config.accessToken, {
    method: 'POST',
    body: { recipient: { id: jid.split('@')[0] }, messaging_type: 'RESPONSE', message: { text } },
  })
  if (!data.message_id) throw new Error('發送失敗')
  return data.message_id
}

export interface TemplateMessage { name: string; language: string; params: string[] }

/**
 * A pre-approved message template: the only way to start a WhatsApp conversation through
 * the Cloud API, or to message someone more than 24 hours after they last wrote.
 */
export async function sendCloudTemplate(numberId: number, phone: string, template: TemplateMessage) {
  const config = numberConfig<CloudConfig>(numberId)
  const data = await graph<{ messages?: { id: string }[] }>(`${FB}/${encodeURIComponent(config.phoneNumberId)}/messages`, config.accessToken, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.params.length
          ? [{ type: 'body', parameters: template.params.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    },
  })
  const id = data.messages?.[0]?.id
  if (!id) throw new Error('發送失敗')
  return id
}

/** quickReplies: tappable chips under the message (Instagram app only; the tapped title comes back as text). */
export async function sendInstagramText(numberId: number, conversationId: number, jid: string, text: string, quickReplies?: readonly { id: string; title: string }[] | null) {
  assertServiceWindow(conversationId)
  const config = numberConfig<InstagramConfig>(numberId)
  const data = await graph<{ message_id?: string }>(`${igBase(config)}/${encodeURIComponent(igSender(config))}/messages`, config.accessToken, {
    method: 'POST',
    body: {
      recipient: { id: jid.split('@')[0] },
      message: { text, ...(quickReplies?.length ? { quick_replies: quickReplies.map((q) => ({ content_type: 'text', title: q.title, payload: q.id })) } : {}) },
    },
  })
  if (!data.message_id) throw new Error('發送失敗')
  return data.message_id
}

/**
 * Answer an Instagram comment with a private message (DM) to the person who wrote it.
 * Meta allows one private reply per comment, within 7 days of the comment.
 */
export async function sendInstagramPrivateReply(numberId: number, commentId: string, text: string) {
  const config = numberConfig<InstagramConfig>(numberId)
  return graph<{ recipient_id?: string; message_id?: string }>(`${igBase(config)}/${encodeURIComponent(igSender(config))}/messages`, config.accessToken, {
    method: 'POST',
    body: { recipient: { comment_id: commentId }, message: { text } },
  })
}

/** Facebook: a private message to the person who commented on the Page's post (once, within 7 days). */
export async function sendFacebookPrivateReply(numberId: number, commentId: string, text: string) {
  const config = numberConfig<MessengerConfig>(numberId)
  return graph<{ recipient_id?: string; message_id?: string }>(`${FB}/${encodeURIComponent(config.pageId)}/messages`, config.accessToken, {
    method: 'POST',
    body: { recipient: { comment_id: commentId }, message: { text } },
  })
}

export async function replyToFacebookComment(numberId: number, commentId: string, text: string) {
  const config = numberConfig<MessengerConfig>(numberId)
  return graph(`${FB}/${encodeURIComponent(commentId)}/comments`, config.accessToken, { method: 'POST', body: { message: text } })
}

/** A public answer under the comment, e.g. "已私訊你 😊". */
export async function replyToInstagramComment(numberId: number, commentId: string, text: string) {
  const config = numberConfig<InstagramConfig>(numberId)
  return graph(`${igBase(config)}/${encodeURIComponent(commentId)}/replies`, config.accessToken, { method: 'POST', body: { message: text } })
}

// ---------- Instagram history sync (TASK-9) ----------

export interface IgHistorySummary {
  conversations: number; messages: number; skipped: number
  /** How many conversations Meta's list call returned this run (all pages). */
  listed: number
  /** Conversations whose messages could not be read; the run continued past them. */
  failed: number
  /** The first failure's message, present only when failed > 0. */
  error?: string
}

type IgParticipant = { id?: string; username?: string }
type IgAttachment = {
  id?: string; mime_type?: string; name?: string
  image_data?: { url?: string }; video_data?: unknown; file_url?: string
}
type IgHistoryMessage = {
  id?: string; created_time?: string; message?: string
  from?: IgParticipant
  /** Meta returns the recipients as { data: [...] }; accept a bare object too. */
  to?: { data?: IgParticipant[] } | IgParticipant
  attachments?: { data?: IgAttachment[] }
}
type IgConversation = { id?: string; participants?: { data?: IgParticipant[] } }
type GraphPage<T> = { data?: T[]; paging?: { next?: string } }

/** Safety cap so a huge account cannot page Meta (or us) forever: 100 pages per edge. */
const HISTORY_MAX_PAGES = 100

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** History-sync waits, scaled by BATON_HISTORY_DELAY_SCALE (tests set it to 0). */
const historySleep = (ms: number) => sleep(ms * Number(process.env.BATON_HISTORY_DELAY_SCALE ?? 1))
/** Backoff before each retry of a throttled history request: 3 retries, then give up. */
const HISTORY_RETRY_WAITS_MS = [5_000, 20_000, 60_000]
/** Pause between conversations, so a long sync does not burst against Meta's limits. */
const HISTORY_CONVERSATION_GAP_MS = 250

/**
 * Meta throttling errors — "(#4) Application request limit reached", "(#17) User
 * request limit reached", "(#32) Page request limit reached", "(#613) Calls to this
 * api have exceeded the rate limit". graph() flattens errors to a message string,
 * so match on the wording and the code.
 */
function isTransientMetaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('limit reached') || /\(#(4|17|32|613)\)/.test(message)
}

/** One page of a history edge; a throttled request is retried with backoff. */
async function graphHistoryPage<T>(url: string, token: string): Promise<GraphPage<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await graph<GraphPage<T>>(url, token)
    } catch (err) {
      const wait = HISTORY_RETRY_WAITS_MS[attempt]
      if (wait === undefined || !isTransientMetaError(err)) throw err
      await historySleep(wait)
    }
  }
}

/** Follow paging.next through a Graph edge, up to the page cap. */
async function graphAll<T>(firstUrl: string, token: string): Promise<T[]> {
  const out: T[] = []
  let url: string | undefined = firstUrl
  for (let page = 0; url && page < HISTORY_MAX_PAGES; page++) {
    const r: GraphPage<T> = await graphHistoryPage<T>(url, token)
    out.push(...(r.data ?? []))
    url = r.paging?.next
  }
  return out
}

function historyMessageShape(m: IgHistoryMessage): { type: MessageType; body: string; mediaMime: string | null } {
  const text = m.message ?? ''
  if (text) return { type: 'text', body: text, mediaMime: null }
  // Media itself is not downloaded; only its type / mime metadata is kept.
  const att = m.attachments?.data?.[0]
  if (!att) return { type: 'other', body: '', mediaMime: null }
  const mime = att.mime_type ?? null
  const type: MessageType = mime?.startsWith('image/') || att.image_data ? 'image'
    : mime?.startsWith('video/') || att.video_data ? 'video'
      : mime?.startsWith('audio/') ? 'audio'
        : att.file_url ? 'document' : 'other'
  return { type, body: att.name ?? '', mediaMime: mime }
}

/**
 * Import an Instagram account's pre-existing DM conversations. Manual and idempotent:
 * messages are filed by their Meta id through the normal store, so re-running adds
 * nothing. Everything is stored as history (live: false) — no unread badges, no AI
 * replies, no waiting alerts, and nothing is ever sent. Conversations the sync itself
 * creates are closed; conversations that already existed keep their state.
 * Each conversation is imported in isolation: if Meta refuses one (after the throttle
 * retries in graphAll), the run counts it in `failed`, keeps the first error message,
 * and moves on — a re-run fills the gaps, since stored messages dedupe by Meta id.
 */
export async function syncInstagramHistory(numberId: number): Promise<IgHistorySummary> {
  const config = numberConfig<InstagramConfig>(numberId)
  const base = igBase(config)
  // Facebook route reads the conversation list through the Page when one is linked.
  const owner = config.host === 'facebook' && config.pageId ? config.pageId : config.igUserId
  const ownIds = new Set([config.igUserId, config.pageId].filter(Boolean).map(String))
  const before = new Set(all<{ id: number }>('SELECT id FROM conversations WHERE number_id = ?', numberId).map((c) => c.id))
  const summary: IgHistorySummary = { conversations: 0, messages: 0, skipped: 0, listed: 0, failed: 0 }
  const fresh = new Set<number>()

  const conversations = await graphAll<IgConversation>(
    `${base}/${encodeURIComponent(owner)}/conversations?platform=instagram&fields=id,participants{id,username}&limit=100`,
    config.accessToken,
  )
  summary.listed = conversations.length
  for (const [index, conv] of conversations.entries()) {
    if (index > 0) await historySleep(HISTORY_CONVERSATION_GAP_MS)
    if (!conv.id) continue
    try {
      const participants = conv.participants?.data ?? []
      const messages = await graphAll<IgHistoryMessage>(
        `${base}/${encodeURIComponent(conv.id)}/messages?fields=id,created_time,from{id,username},to{id,username},message,attachments&limit=100`,
        config.accessToken,
      )
      for (const m of messages) {
        if (!m.id) { summary.skipped++; continue }
        const fromMe = ownIds.has(String(m.from?.id ?? ''))
        const toList: IgParticipant[] = !m.to ? []
          : 'data' in m.to && Array.isArray(m.to.data) ? m.to.data
            : [m.to as IgParticipant]
        // The customer is the sender of an incoming message, a recipient of ours, or the
        // conversation's other participant when neither names them.
        const notUs = (p: IgParticipant) => Boolean(p.id) && !ownIds.has(String(p.id))
        const other = fromMe ? toList.find(notUs) ?? participants.find(notUs) : m.from
        const ts = Math.floor(Date.parse(m.created_time ?? '') / 1000)
        if (!other?.id || !Number.isFinite(ts)) { summary.skipped++; continue }
        const shape = historyMessageShape(m)
        const stored = storeMessage({
          numberId, jid: `${other.id}@instagram`, contact: { ig: String(other.id) },
          waName: other.username ? `@${other.username}` : undefined,
          waId: m.id, fromMe, type: shape.type, body: shape.body, mediaMime: shape.mediaMime, ts, live: false,
        })
        if (!stored) { summary.skipped++; continue } // Already in the DB (dedupe by Meta message id).
        summary.messages++
        if (!before.has(stored.conversationId)) fresh.add(stored.conversationId)
      }
    } catch (err) {
      // One bad conversation must not sink the run; messages it already stored stay
      // stored, and a re-run picks up the rest.
      summary.failed++
      if (summary.error === undefined) summary.error = err instanceof Error ? err.message : String(err)
    }
  }
  for (const id of fresh) run("UPDATE conversations SET status = 'closed', unread = 0 WHERE id = ?", id)
  summary.conversations = fresh.size
  return summary
}

// ---------- Webhook ----------

/**
 * Emits 'comment' ({ platform: 'instagram' | 'facebook', numberId, ownId, comment }) for each
 * new comment on the business's posts.
 */
export const metaEvents = new EventEmitter()

/** Meta signs each delivery with the app secret; reject anything that doesn't match. */
export function validSignature(rawBody: Buffer | undefined, header: string | undefined) {
  // META_APP_SECRET_2: a second Meta app (e.g. one owned by another business portfolio) posting to the same webhook.
  const secrets = [process.env.META_APP_SECRET, process.env.META_APP_SECRET_2, process.env.INSTAGRAM_APP_SECRET].filter((s): s is string => Boolean(s))
  if (secrets.length === 0) return true
  if (!rawBody || !header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  return secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
    return expected.length === given.length && crypto.timingSafeEqual(expected, given)
  })
}

function numberFor(channel: 'wa_cloud' | 'instagram' | 'messenger', key: 'phoneNumberId' | 'igUserId' | 'pageId', value: string) {
  return get<{ id: number }>(
    `SELECT id FROM numbers WHERE channel = ? AND status = 'connected' AND json_extract(config, '$.${key}') = ?`, channel, value,
  )?.id
}

type CloudMessage = {
  id: string; from: string; timestamp: string; type: string
  text?: { body: string }
  image?: { id: string; caption?: string }; video?: { id: string; caption?: string }; sticker?: { id: string }
  audio?: { id: string; voice?: boolean }; document?: { id: string; filename?: string; caption?: string }
  location?: { name?: string; address?: string; latitude: number; longitude: number }
  contacts?: { name?: { formatted_name?: string } }[]
  button?: { text?: string }
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { title?: string } }
}

function describeCloud(m: CloudMessage): { type: MessageType; body: string; mediaId?: string } | null {
  switch (m.type) {
    case 'text': return { type: 'text', body: m.text?.body ?? '' }
    case 'image': return { type: 'image', body: m.image?.caption ?? '', mediaId: m.image?.id }
    case 'video': return { type: 'video', body: m.video?.caption ?? '', mediaId: m.video?.id }
    case 'sticker': return { type: 'sticker', body: '', mediaId: m.sticker?.id }
    case 'audio': return { type: m.audio?.voice ? 'voice' : 'audio', body: '', mediaId: m.audio?.id }
    case 'document': return { type: 'document', body: m.document?.filename ?? m.document?.caption ?? '', mediaId: m.document?.id }
    case 'location': {
      const l = m.location
      return { type: 'location', body: [l?.name, l?.address, l && `${l.latitude},${l.longitude}`].filter(Boolean).join(' · ') }
    }
    case 'contacts': return { type: 'contact', body: m.contacts?.[0]?.name?.formatted_name ?? '' }
    case 'button': return { type: 'text', body: m.button?.text ?? '' }
    case 'interactive':
      // Recognise our own button by its id, so the request goes through even if the title is ever reworded.
      if (m.interactive?.button_reply?.id === HUMAN_BUTTON.id || LEGACY_HUMAN_BUTTON_IDS.has(m.interactive?.button_reply?.id ?? '')) {
        return { type: 'text', body: HUMAN_BUTTON.title }
      }
      return { type: 'text', body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '' }
    case 'reaction': return null
    default: return { type: 'other', body: '' }
  }
}

type InstagramEvent = {
  sender: { id: string }; recipient: { id: string }; timestamp: number
  message?: {
    mid: string; text?: string; is_echo?: boolean; is_deleted?: boolean
    attachments?: { type: string; payload?: { url?: string } }[]
  }
}

const IG_ATTACHMENT: Record<string, MessageType> = { image: 'image', video: 'video', audio: 'audio', file: 'document' }

/** Store every message a webhook delivery contains. Media downloads finish in the background. */
export function handleWebhook(payload: any) {
  // Shown on the setup checklist, so the team can see Meta is reaching the server.
  if (typeof payload?.object === 'string') setSetting(`webhook_last_${payload.object}`, String(Math.floor(Date.now() / 1000)))
  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue
        const value = change.value ?? {}
        const numberId = numberFor('wa_cloud', 'phoneNumberId', String(value.metadata?.phone_number_id ?? ''))
        if (!numberId) continue
        // Delivery and read receipts for messages we sent, e.g. broadcasts.
        for (const st of (value.statuses ?? []) as { id: string; status: string; timestamp: string; errors?: { title?: string }[] }[]) {
          const ts = Number(st.timestamp)
          if (st.status === 'delivered') run('UPDATE campaign_recipients SET delivered_at = COALESCE(delivered_at, ?) WHERE wa_id = ?', ts, st.id)
          if (st.status === 'read') run('UPDATE campaign_recipients SET read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?) WHERE wa_id = ?', ts, ts, st.id)
          if (st.status === 'failed') run("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE wa_id = ?", st.errors?.[0]?.title ?? 'WhatsApp 未能送達', st.id)
        }
        const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]))
        for (const m of (value.messages ?? []) as CloudMessage[]) {
          const described = describeCloud(m)
          if (!described) continue
          // Align by the webhook's wa_id (phone digits) and profile name.
          const contacts = (value.contacts ?? []) as { wa_id?: string; profile?: { name?: string } }[]
          const waId = String(contacts.find((c) => c.wa_id === m.from)?.wa_id ?? (contacts.length === 1 ? contacts[0].wa_id : m.from) ?? '').replace(/\D/g, '')
          if (!waId) continue
          const stored = storeMessage({
            numberId, jid: `${waId}@s.whatsapp.net`, contact: { pn: waId }, waName: names.get(m.from) ?? contacts.find((c) => c.wa_id === waId)?.profile?.name,
            waId: m.id, fromMe: false, type: described.type, body: described.body, ts: Number(m.timestamp), live: true,
          })
          if (stored && described.mediaId) {
            downloadCloudMedia(numberId, m.id, described.mediaId).catch((err) => console.warn('WhatsApp media download failed', err))
          }
        }
      }
    }
  }

  if (payload?.object === 'instagram') {
    for (const entry of payload.entry ?? []) {
      const numberId = numberFor('instagram', 'igUserId', String(entry.id ?? ''))
      if (!numberId) continue
      for (const change of entry.changes ?? []) {
        if (change.field === 'comments' && change.value?.id) {
          metaEvents.emit('comment', { platform: 'instagram', numberId, ownId: String(entry.id), comment: change.value })
        }
      }
      storeMessagingEvents('instagram', numberId, entry.messaging ?? [])
    }
  }

  if (payload?.object === 'page') {
    for (const entry of payload.entry ?? []) {
      const numberId = numberFor('messenger', 'pageId', String(entry.id ?? ''))
      if (!numberId) continue
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {}
        if (change.field === 'feed' && v.item === 'comment' && v.verb === 'add' && v.comment_id) {
          metaEvents.emit('comment', {
            platform: 'facebook', numberId, ownId: String(entry.id),
            comment: { id: v.comment_id, text: v.message ?? '', from: { id: v.from?.id, username: v.from?.name } },
          })
        }
      }
      storeMessagingEvents('messenger', numberId, entry.messaging ?? [])
    }
  }
}

/** Instagram and Messenger deliver direct messages in the same shape. */
function storeMessagingEvents(channel: 'instagram' | 'messenger', numberId: number, events: InstagramEvent[]) {
  for (const event of events) {
    const m = event.message
    if (!m?.mid || m.is_deleted) continue
    // Echoes are the business's own messages, including ones sent from the Instagram / Messenger app.
    const fromMe = Boolean(m.is_echo)
    const customer = fromMe ? event.recipient.id : event.sender.id
    const attachment = m.attachments?.[0]
    const type: MessageType = m.text ? 'text' : attachment ? IG_ATTACHMENT[attachment.type] ?? 'other' : 'other'
    const domain = channel === 'instagram' ? 'instagram' : 'messenger'
    // The echo of a message Baton itself sent can carry a different id from the send reply (Page
    // route): skip it, or it shows twice as "sent from the phone" and pauses the AI.
    if (fromMe && get(
      `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.number_id = ? AND c.jid = ? AND m.from_me = 1 AND (m.sender_id IS NOT NULL OR m.ai_auto = 1)
         AND m.type = ? AND m.body = ? AND m.wa_id != ? AND abs(m.ts - ?) <= 120`,
      numberId, `${customer}@${domain}`, type, m.text ?? '', m.mid, Math.floor(event.timestamp / 1000),
    )) continue
    const stored = storeMessage({
      numberId, jid: `${customer}@${domain}`, contact: channel === 'instagram' ? { ig: customer } : { fb: customer }, waId: m.mid, fromMe,
      type, body: m.text ?? '', ts: Math.floor(event.timestamp / 1000), live: true,
    })
    if (!stored) continue
    if (attachment?.payload?.url && IG_ATTACHMENT[attachment.type]) {
      saveMedia(numberId, m.mid, attachment.payload.url).catch((err) => console.warn(`${channel} media download failed`, err))
    }
    fillName(channel, numberId, customer).catch(() => {
      // Profile lookups need the customer to have messaged first; their messages are still stored.
    })
  }
}

async function downloadCloudMedia(numberId: number, waId: string, mediaId: string) {
  const { accessToken } = numberConfig<CloudConfig>(numberId)
  const info = await graph<{ url: string }>(`${FB}/${encodeURIComponent(mediaId)}`, accessToken)
  await saveMedia(numberId, waId, info.url, accessToken)
}

async function saveMedia(numberId: number, waId: string, url: string, token?: string) {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : undefined })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const mime = res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
  const ext = mime.split('/')[1] ?? 'bin'
  const safeId = waId.replace(/[^\w.-]/g, '_')
  const rel = path.join(String(numberId), `${safeId}.${ext}`)
  fs.mkdirSync(path.join(MEDIA_DIR, String(numberId)), { recursive: true })
  fs.writeFileSync(path.join(MEDIA_DIR, rel), Buffer.from(await res.arrayBuffer()))
  setMessageMedia(numberId, waId, rel, mime)
  broadcast('media', { waId, mediaPath: rel, mime })
}

/** Instagram and Messenger webhooks carry only an ID; look up the customer's name once. */
async function fillName(channel: 'instagram' | 'messenger', numberId: number, id: string) {
  const contact = get<{ id: number; wa_name: string | null }>('SELECT id, wa_name FROM contacts WHERE phone = ?', `${channel === 'instagram' ? 'ig' : 'fb'}:${id}`)
  // Look up once, and again if we only know the "@username" (e.g. from a comment).
  if (!contact || (contact.wa_name && !contact.wa_name.startsWith('@'))) return
  const { accessToken, host } = numberConfig<{ accessToken: string; host?: InstagramHost }>(numberId)
  const profile = channel === 'instagram'
    ? await graph<{ name?: string; username?: string }>(`${igBase({ host })}/${encodeURIComponent(id)}?fields=name,username`, accessToken)
    : await graph<{ name?: string; username?: string }>(`${FB}/${encodeURIComponent(id)}?fields=name`, accessToken)
  const name = profile.name && profile.username ? `${profile.name} (@${profile.username})` : profile.name ?? (profile.username && `@${profile.username}`)
  if (!name) return
  run('UPDATE contacts SET wa_name = ?, updated_at = unixepoch() WHERE id = ?', name, contact.id)
  broadcast('refresh', { scope: 'contacts' })
}
