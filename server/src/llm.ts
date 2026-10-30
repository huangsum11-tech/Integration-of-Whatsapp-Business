/**
 * One way to call whichever AI the company picked in settings: Claude (Anthropic),
 * Gemini (Google) or Grok (xAI). API keys come from environment variables only.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getSetting } from './db.js'

export type Provider = 'claude' | 'gemini' | 'grok'

export const PROVIDERS: Record<Provider, { label: string; keyEnv: string; defaultModel: string }> = {
  claude: { label: 'Claude（Anthropic）', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: process.env.BATON_AI_MODEL ?? 'claude-opus-5-5' },
  gemini: { label: 'Gemini（Google）', keyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-3.6-flash' },
  grok: { label: 'Grok（xAI）', keyEnv: 'XAI_API_KEY', defaultModel: 'grok-4.6' },
}

export interface LlmRequest {
  /** Fixed instructions for this kind of request. */
  instructions: string
  /** Large, slowly changing context (voice examples, knowledge base); cached where the provider supports it. */
  context: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens?: number
}

export class AiUnavailableError extends Error {}

export function currentAi(): { provider: Provider; model: string } {
  const stored = getSetting('ai_provider', 'claude')
  const provider: Provider = stored in PROVIDERS ? (stored as Provider) : 'claude'
  return { provider, model: getSetting(`ai_model_${provider}`) || PROVIDERS[provider].defaultModel }
}

export function hasKey(provider: Provider) {
  // The Anthropic SDK can also authenticate with ANTHROPIC_AUTH_TOKEN.
  return Boolean(process.env[PROVIDERS[provider].keyEnv] || (provider === 'claude' && process.env.ANTHROPIC_AUTH_TOKEN))
}

export async function generate(req: LlmRequest): Promise<string> {
  const { provider, model } = currentAi()
  if (!hasKey(provider)) throw new AiUnavailableError(`未設定 ${PROVIDERS[provider].keyEnv}，AI 暫不可用`)
  const text = provider === 'claude' ? await claude(model, req) : provider === 'gemini' ? await gemini(model, req) : await grok(model, req)
  if (!text.trim()) throw new Error('AI 未有產生內容')
  return text.trim()
}

let anthropic: Anthropic | undefined

async function claude(model: string, req: LlmRequest): Promise<string> {
  anthropic ??= new Anthropic()
  let response
  try {
    response = await anthropic.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: req.instructions },
        // Stable across requests (knowledge base, voice examples), so cache it.
        { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } },
      ],
      messages: req.messages,
    })
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiUnavailableError('ANTHROPIC_API_KEY 無效，AI 暫不可用')
    throw err
  }
  if (response.stop_reason === 'refusal') throw new Error('AI 未能處理此對話，請手動回覆')
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

async function gemini(model: string, req: LlmRequest): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${req.instructions}\n\n${req.context}` }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: req.maxTokens ?? 2000 },
    }),
  })
  const data = await res.json().catch(() => ({})) as {
    error?: { message?: string }
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
  }
  if (res.status === 401 || res.status === 403) throw new AiUnavailableError('GEMINI_API_KEY 無效，AI 暫不可用')
  if (!res.ok) throw new Error(`Gemini 錯誤：${data.error?.message ?? res.status}`)
  return (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('')
}

async function grok(model: string, req: LlmRequest): Promise<string> {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 2000,
      messages: [{ role: 'system', content: `${req.instructions}\n\n${req.context}` }, ...req.messages],
    }),
  })
  const data = await res.json().catch(() => ({})) as {
    error?: { message?: string } | string
    choices?: { message?: { content?: string } }[]
  }
  if (res.status === 401 || res.status === 403) throw new AiUnavailableError('XAI_API_KEY 無效，AI 暫不可用')
  if (!res.ok) throw new Error(`Grok 錯誤：${typeof data.error === 'string' ? data.error : data.error?.message ?? res.status}`)
  return data.choices?.[0]?.message?.content ?? ''
}
