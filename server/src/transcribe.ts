/**
 * Voice messages to text with Gemini (it understands Cantonese well), so the AI can answer
 * voice notes and teammates can skim them. Runs when the audio finishes downloading, if
 * GEMINI_API_KEY is set, whichever AI answers customers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { get, getSetting, run } from './db.js'
import { inboxEvents } from './inbox.js'
import { PROVIDERS } from './llm.js'
import { broadcast } from './realtime.js'
import { MEDIA_DIR } from './whatsapp.js'

export const canTranscribe = () => Boolean(process.env.GEMINI_API_KEY)

async function transcribe(messageId: number) {
  const m = get<{ type: string; media_path: string | null; media_mime: string | null; transcript: string | null }>(
    'SELECT type, media_path, media_mime, transcript FROM messages WHERE id = ?', messageId,
  )
  if (!m?.media_path || m.transcript || !['voice', 'audio'].includes(m.type)) return
  const file = path.join(MEDIA_DIR, m.media_path)
  const data = fs.readFileSync(file)
  if (data.length > 15 * 1024 * 1024) return
  const model = getSetting('ai_model_gemini') || PROVIDERS.gemini.defaultModel
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: (m.media_mime ?? 'audio/ogg').split(';')[0], data: data.toString('base64') } },
          { text: '把這段語音逐字轉寫成文字。廣東話請用繁體中文口語字（例如「係」「唔」「嘅」），英文保留英文。只輸出轉寫內容，不要加任何說明。聽不清楚的部分寫（聽不清楚）。' },
        ],
      }],
    }),
  })
  const json = await res.json().catch(() => ({})) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; error?: { message?: string } }
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
  const text = (json.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim()
  if (!text) return
  run('UPDATE messages SET transcript = ? WHERE id = ?', text, messageId)
  broadcast('media', { messageId })
  inboxEvents.emit('transcribed', { messageId })
}

inboxEvents.on('media-saved', ({ messageId }: { messageId: number }) => {
  if (!canTranscribe()) return
  transcribe(messageId).catch((err) => console.warn('Voice transcription failed', err))
})
