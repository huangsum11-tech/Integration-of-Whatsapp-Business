/**
 * Instagram (Instagram Login) and Threads long-lived tokens expire after 60 days unless
 * refreshed. Once a day, any token not refreshed for a week is exchanged for a fresh one.
 * WhatsApp system-user tokens and Page tokens from a system user do not expire.
 */
import { all, run } from './db.js'

const REFRESH: Record<string, (token: string) => string> = {
  instagram: (t) => `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t)}`,
  threads: (t) => `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(t)}`,
}
const WEEK = 7 * 86400

async function refreshAll() {
  const numbers = all<{ id: number; channel: string; config: string }>(
    "SELECT id, channel, config FROM numbers WHERE channel IN ('instagram','threads') AND status = 'connected'",
  )
  for (const n of numbers) {
    const config = JSON.parse(n.config || '{}') as { accessToken?: string; refreshedAt?: number }
    if (!config.accessToken || (config.refreshedAt ?? 0) > Date.now() / 1000 - WEEK) continue
    try {
      const res = await fetch(REFRESH[n.channel](config.accessToken))
      const data = await res.json() as { access_token?: string; error?: { message?: string } }
      if (!res.ok || !data.access_token) throw new Error(data.error?.message ?? `HTTP ${res.status}`)
      run('UPDATE numbers SET config = ? WHERE id = ?', JSON.stringify({ ...config, accessToken: data.access_token, refreshedAt: Math.floor(Date.now() / 1000) }), n.id)
    } catch (err) {
      console.warn(`Token refresh failed for number ${n.id}`, err instanceof Error ? err.message : err)
    }
  }
}

export function startTokenRefresh() {
  setTimeout(() => { refreshAll().catch(() => {}) }, 60_000)
  setInterval(() => { refreshAll().catch(() => {}) }, 86400_000)
}
