/**
 * Timetable picture: a customer asking for the timetable gets the brand's own picture in
 * 'auto' mode; no picture (or 'suggest' mode) falls back to the usual answer.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { setup } from './helpers.ts'

const t = await setup()
const { db, ask, fitness, pilates } = t
const { MEDIA_DIR } = await import('../src/whatsapp.js')
const { TIMETABLE_REQUEST } = await import('../src/autoreply.js')

fs.mkdirSync(path.join(MEDIA_DIR, 'uploads'), { recursive: true })
fs.writeFileSync(path.join(MEDIA_DIR, 'uploads', 'pilates-timetable.png'), 'png')
db.run("UPDATE brands SET timetable_image = 'uploads/pilates-timetable.png', booking_platform = 'Fuse App' WHERE id = ?", t.brandId('pilates'))

const images = (conversationId: number) =>
  db.all<{ media_path: string }>("SELECT media_path FROM messages WHERE conversation_id = ? AND from_me = 1 AND type = 'image'", conversationId).map((m) => m.media_path)

test('asking for the timetable sends that brand\'s picture with a short line', async () => {
  const r = await ask(pilates, '85291110001', '有冇時間表？')
  assert.match(r.text, /最新時間表/)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(images(r.conversationId), ['uploads/pilates-timetable.png'])
})

test('a brand without a timetable picture sends no picture', async () => {
  const r = await ask(fitness, '85291110002', '時間表')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(images(r.conversationId), [])
})

test('only timetable questions match; "which classes" stays a knowledge-base answer', () => {
  for (const q of ['時間表', '有冇 timetable', '星期六邊日有堂', '上堂時間係幾點']) assert.ok(TIMETABLE_REQUEST.test(q), q)
  for (const q of ['有咩堂', '幾錢', '想試堂']) assert.ok(!TIMETABLE_REQUEST.test(q), q)
})
