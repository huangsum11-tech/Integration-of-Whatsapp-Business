export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? `請求失敗 (${res.status})`, res.status)
  return data as T
}

export interface User {
  id: number; name: string; email: string; role: 'admin' | 'agent'; active: number; color: string
  style_notes?: string; open_conversations?: number; owned_contacts?: number; deactivated_at?: number | null
}

export interface Conversation {
  id: number; number_id: number; contact_id: number; jid: string; assignee_id: number | null
  status: 'open' | 'closed'; unread: number; last_message_at: number; last_preview: string
  /** Null while WhatsApp hides the customer's number behind a LID. */
  phone: string | null; contact_name: string; number_label: string; number_phone: string | null
  channel: Channel; reply_mode: ReplyMode
  /** 1 once a teammate (or an AI handoff) took over from automatic replies. */
  ai_paused: number
  /** The AI's suggested reply, waiting for a teammate (reply mode 'suggest'). */
  ai_suggestion: string | null
  /** 1 while the AI has handed the conversation to the team and nobody has replied yet. */
  needs_human: number
}

export type Channel = 'wa_web' | 'wa_cloud' | 'instagram'
export type ReplyMode = 'off' | 'suggest' | 'auto'

export interface Message {
  item: 'message'; id: number; conversation_id: number; wa_id: string; from_me: number
  sender_id: number | null; sender_name: string | null; type: string; body: string
  media_path: string | null; media_mime: string | null; ts: number; ai_assisted: number
  /** Sent by the AI on its own. */
  ai_auto: number
  /** Text of a voice message. */
  transcript: string | null
}

export interface InboxEvent {
  item: 'event'; id: number; conversation_id: number; user_id: number | null; user_name: string | null
  kind: string; body: string; target_user_id: number | null; target_name: string | null; ts: number
}

export interface Contact {
  id: number; phone: string | null; lid: string | null; name: string | null; saved_name: string | null
  wa_name: string | null; notes: string
  /** 1 for Instagram customers, who have no phone number. */
  instagram?: number
  owner_id: number | null; display_name?: string; owner_name?: string | null
  conversations?: number; numbers?: string | null; tags?: string | null; last_message_at?: number | null; won_amount?: number
}

export interface Deal {
  id: number; contact_id: number; conversation_id: number | null; user_id: number | null
  user_name?: string; title: string; amount: number; stage: 'open' | 'won' | 'lost'; created_at: number
}

export interface WaNumber {
  id: number; label: string; phone: string | null; status: string; demo: number
  conversations: number; qr: string | null; channel: Channel; reply_mode: ReplyMode
  /** Official API IDs (never the access token). */
  ids: { phoneNumberId?: string; igUserId?: string; username?: string }
}

export type KnowledgeCategory = 'faq' | 'policy' | 'class' | 'other'

export interface Knowledge {
  id: number; category: KnowledgeCategory; title: string; body: string; keywords: string; active: number; updated_at: number
}

export interface AiSettings {
  provider: string; model: string
  providers: { id: string; label: string; keyEnv: string; hasKey: boolean; defaultModel: string; model: string }[]
  business_name: string; business_intro: string; handoff_message: string
  trial_booking_url: string; booking_url: string
}

export interface Trial {
  id: number; contact_id: number; conversation_id: number | null; class_at: number; class_name: string
  source: 'ai' | 'staff'; status: 'booked' | 'cancelled'
  followup_status: 'pending' | 'sent' | 'failed' | 'skipped'; followup_error: string | null; followup_at: number | null
  contact_name?: string
}

export interface QuickReply { id: number; shortcut: string; body: string }
