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
}

export interface Message {
  item: 'message'; id: number; conversation_id: number; wa_id: string; from_me: number
  sender_id: number | null; sender_name: string | null; type: string; body: string
  media_path: string | null; media_mime: string | null; ts: number; ai_assisted: number
}

export interface InboxEvent {
  item: 'event'; id: number; conversation_id: number; user_id: number | null; user_name: string | null
  kind: string; body: string; target_user_id: number | null; target_name: string | null; ts: number
}

export interface Contact {
  id: number; phone: string | null; lid: string | null; name: string | null; saved_name: string | null
  wa_name: string | null; notes: string
  owner_id: number | null; display_name?: string; owner_name?: string | null
  conversations?: number; numbers?: string | null; last_message_at?: number | null; won_amount?: number
}

export interface Deal {
  id: number; contact_id: number; conversation_id: number | null; user_id: number | null
  user_name?: string; title: string; amount: number; stage: 'open' | 'won' | 'lost'; created_at: number
}

export interface WaNumber {
  id: number; label: string; phone: string | null; status: string; demo: number
  conversations: number; qr: string | null
}
