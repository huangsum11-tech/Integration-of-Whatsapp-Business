/**
 * Who a WhatsApp customer is. WhatsApp addresses a person by phone number ("…@s.whatsapp.net",
 * "…@c.us", hosted "…@hosted") or by a LID, an opaque long number ("…@lid", hosted "…@hosted.lid").
 * A LID must never be mistaken for a phone number: until it is mapped to a real number the
 * customer is shown as "號碼未解析", never as the LID digits.
 */
import { all, get, run, tx } from './db.js'
import { jidDigits, type ContactIds } from './inbox.js'

export type JidKind = 'pn' | 'lid' | 'other'

export function jidKind(jid: string | null | undefined): JidKind {
  const domain = jid?.split('@')[1]
  if (domain === 's.whatsapp.net' || domain === 'c.us' || domain === 'hosted') return 'pn'
  if (domain === 'lid' || domain === 'hosted.lid') return 'lid'
  return 'other'
}

/** Phone number and/or LID from a chat address and WhatsApp's alternative address for it. */
export function customerIds(jid: string | null | undefined, alt?: string | null): ContactIds {
  const ids = [jid, alt].filter((j): j is string => Boolean(j))
  return {
    pn: jidDigits(ids.find((j) => jidKind(j) === 'pn')),
    lid: jidDigits(ids.find((j) => jidKind(j) === 'lid')),
  }
}

/**
 * Repair customers saved before hosted LIDs ("@hosted.lid") were recognised: their LID digits
 * were stored as the phone number. Mark them as unresolved so the digits are never shown.
 */
export function repairLidContacts() {
  let fixed = 0
  tx(() => {
    for (const c of all<{ contact_id: number; jid: string; lid: string | null; phone: string }>(
      `SELECT cv.contact_id, cv.jid, ct.lid, ct.phone FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       WHERE (cv.jid LIKE '%@lid' OR cv.jid LIKE '%@hosted.lid') AND ct.lid IS NULL`,
    )) {
      const lid = jidDigits(c.jid)
      if (!lid || get('SELECT 1 FROM contacts WHERE lid = ?', lid)) continue
      run('UPDATE contacts SET lid = ? WHERE id = ?', lid, c.contact_id)
      fixed++
    }
  })
  return fixed
}
