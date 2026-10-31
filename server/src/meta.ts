/**
 * Official Meta APIs: the WhatsApp Business Cloud API and the Instagram Messaging API
 * (Instagram API with Instagram Login). Both deliver customer messages to one webhook,
 * /webhooks/meta, and send replies with an access token stored on the number.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { get, run } from './db.js'
import { setMessageMedia, storeMessage, type MessageType } from './inbox.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR } from './whatsapp.js'

const VERSION = process.env.META_GRAPH_VERSION ?? 'v23.0'
const FB = `https://graph.facebook.com/${VERSION}`
const IG = `https://graph.instagram.com/${VERSION}`

export interface CloudConfig { phoneNumberId: string; accessToken: string }
export interface InstagramConfig { igUserId: string; accessToken: string; username?: string }

export function numberConfig<T>(numberId: number): T {
  const row = get<{ config: string }>('SELECT config FROM numbers WHERE id = ?', numberId)
  return JSON.parse(row?.config || '{}') as T
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
export async function verifyInstagram(accessToken: string) {
  const me = await graph<{ user_id?: string; id?: string; username?: string }>(`${IG}/me?fields=user_id,username`, accessToken)
  const igUserId = me.user_id ?? me.id
  if (!igUserId) throw new Error('未能讀取 Instagram 帳戶')
  return { igUserId: String(igUserId), username: me.username ?? '' }
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

export async function sendInstagramText(numberId: number, conversationId: number, jid: string, text: string) {
  assertServiceWindow(conversationId)
  const config = numberConfig<InstagramConfig>(numberId)
  const data = await graph<{ message_id?: string }>(`${IG}/${encodeURIComponent(config.igUserId)}/messages`, config.accessToken, {
    method: 'POST',
    body: { recipient: { id: jid.split('@')[0] }, message: { text } },
  })
  if (!data.message_id) throw new Error('發送失敗')
  return data.message_id
}

// ---------- Webhook ----------

/** Meta signs each delivery with the app secret; reject anything that doesn't match. */
export function validSignature(rawBody: Buffer | undefined, header: string | undefined) {
  const secrets = [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter((s): s is string => Boolean(s))
  if (secrets.length === 0) return true
  if (!rawBody || !header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  return secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
    return expected.length === given.length && crypto.timingSafeEqual(expected, given)
  })
}

function numberFor(channel: 'wa_cloud' | 'instagram', key: 'phoneNumberId' | 'igUserId', value: string) {
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
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
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
    case 'interactive': return { type: 'text', body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '' }
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
  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue
        const value = change.value ?? {}
        const numberId = numberFor('wa_cloud', 'phoneNumberId', String(value.metadata?.phone_number_id ?? ''))
        if (!numberId) continue
        const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]))
        for (const m of (value.messages ?? []) as CloudMessage[]) {
          const described = describeCloud(m)
          if (!described) continue
          const stored = storeMessage({
            numberId, jid: `${m.from}@s.whatsapp.net`, contact: { pn: m.from }, waName: names.get(m.from),
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
      for (const event of (entry.messaging ?? []) as InstagramEvent[]) {
        const m = event.message
        if (!m?.mid || m.is_deleted) continue
        // Echoes are the business's own messages, including ones sent from the Instagram app.
        const fromMe = Boolean(m.is_echo)
        const customer = fromMe ? event.recipient.id : event.sender.id
        const attachment = m.attachments?.[0]
        const type: MessageType = m.text ? 'text' : attachment ? IG_ATTACHMENT[attachment.type] ?? 'other' : 'other'
        const stored = storeMessage({
          numberId, jid: `${customer}@instagram`, contact: { ig: customer }, waId: m.mid, fromMe,
          type, body: m.text ?? '', ts: Math.floor(event.timestamp / 1000), live: true,
        })
        if (!stored) continue
        if (attachment?.payload?.url && IG_ATTACHMENT[attachment.type]) {
          saveMedia(numberId, m.mid, attachment.payload.url).catch((err) => console.warn('Instagram media download failed', err))
        }
        fillInstagramName(numberId, customer).catch(() => {
          // Profile lookups need the customer to have messaged first; their messages are still stored.
        })
      }
    }
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

/** Instagram webhooks carry only an ID; look up the customer's name and username once. */
async function fillInstagramName(numberId: number, igsid: string) {
  const contact = get<{ id: number; wa_name: string | null }>('SELECT id, wa_name FROM contacts WHERE phone = ?', `ig:${igsid}`)
  if (!contact || contact.wa_name) return
  const { accessToken } = numberConfig<InstagramConfig>(numberId)
  const profile = await graph<{ name?: string; username?: string }>(`${IG}/${encodeURIComponent(igsid)}?fields=name,username`, accessToken)
  const name = profile.name && profile.username ? `${profile.name} (@${profile.username})` : profile.name ?? (profile.username && `@${profile.username}`)
  if (!name) return
  run('UPDATE contacts SET wa_name = ?, updated_at = unixepoch() WHERE id = ?', name, contact.id)
  broadcast('refresh', { scope: 'contacts' })
}
