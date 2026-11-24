/** Webhook signatures are accepted from either Meta app (Fitness's, or a second business's own app). */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// meta.ts opens the database on import: keep it off the real data folder.
process.env.BATON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'))
process.env.META_APP_SECRET = 'secret-fitness-app'
process.env.META_APP_SECRET_2 = 'secret-pilates-app'
const { validSignature } = await import('../src/meta.ts')

const body = Buffer.from('{"object":"whatsapp_business_account"}')
const sign = (secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

test('either app secret validates; anything else is refused', () => {
  assert.equal(validSignature(body, sign('secret-fitness-app')), true)
  assert.equal(validSignature(body, sign('secret-pilates-app')), true)
  assert.equal(validSignature(body, sign('someone-else')), false)
  assert.equal(validSignature(body, undefined), false)
})
