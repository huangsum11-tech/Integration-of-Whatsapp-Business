/** Wall-clock time in the studio's time zone (Hong Kong by default), for schedules and reminders. */
export const TIME_ZONE = process.env.BATON_TZ ?? 'Asia/Hong_Kong'

export function localParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    /** 0 = Sunday … 6 = Saturday */
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  }
}

/** "2026-11-05 19:00" in the studio's time zone → unix seconds. */
export function parseLocal(text: string): number | null {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  // Shift by the zone's offset at that moment (twice, to settle across a DST change).
  let ts = guess
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(ts))
    ts += guess - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return Math.floor(ts / 1000)
}

/** unix seconds → "2026-11-05 19:00 (週四)" in the studio's time zone. */
export function formatLocal(ts: number) {
  const p = localParts(new Date(ts * 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}（週${'日一二三四五六'[p.weekday]}）`
}
