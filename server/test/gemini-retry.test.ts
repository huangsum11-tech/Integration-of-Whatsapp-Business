/** Gemini "high demand" (503) is retried instead of failing the customer's reply straight away. */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const llm = await import('../src/llm.js')
process.env.GEMINI_API_KEY = 'test-key'
t.db.run("INSERT INTO settings (key, value) VALUES ('ai_provider', 'gemini') ON CONFLICT (key) DO UPDATE SET value = excluded.value")

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('a 503 "high demand" answer is retried, then the reply goes through', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return calls === 1
      ? new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }), { status: 503 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '你好！' }] } }] }), { status: 200 })
  }) as typeof fetch
  const text = await llm.generate({ instructions: 'x', context: '', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(text, '你好！')
  assert.equal(calls, 2)
})

test('a non-retryable error (bad request) fails at once', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Invalid argument' } }), { status: 400 }) }) as typeof fetch
  await assert.rejects(llm.generate({ instructions: 'x', context: '', messages: [{ role: 'user', content: 'hi' }] }), /Invalid argument/)
  assert.equal(calls, 1)
})
