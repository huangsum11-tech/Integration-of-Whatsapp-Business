/**
 * Set a new password for a teammate who forgot theirs (run on the Mac, in the terminal):
 *   cd server && npm run reset-password
 * Asks for the e-mail and the new password (typed hidden), then logs that person out everywhere.
 */
import readline from 'node:readline'
import { hashPassword } from './auth.js'
import { get, run } from './db.js'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
let hidden = false
// Don't echo the password as it's typed.
const write = (rl as unknown as { _writeToOutput: (s: string) => void })
const original = write._writeToOutput.bind(rl)
write._writeToOutput = (s: string) => { if (!hidden || s.includes('\n') || s.includes('：')) original(s) }
// Read line by line from one iterator, so answers typed (or pasted) ahead are not lost.
const lines = rl[Symbol.asyncIterator]()
const ask = async (q: string, secret = false) => {
  process.stdout.write(q)
  hidden = secret
  const { value } = await lines.next()
  hidden = false
  if (secret) process.stdout.write('\n')
  return String(value ?? '').trim()
}

const email = (await ask('帳戶電郵：')).toLowerCase()
const user = get<{ id: number; name: string }>('SELECT id, name FROM users WHERE lower(email) = ?', email)
if (!user) { console.log('搵唔到呢個電郵嘅帳戶，冇改任何嘢。'); process.exit(1) }
const password = await ask('新密碼（最少 8 個字元，打嘅時候唔會顯示）：', true)
if (password.length < 8) { console.log('密碼太短，冇改任何嘢。'); process.exit(1) }
if (await ask('再輸入一次新密碼：', true) !== password) { console.log('兩次唔一樣，冇改任何嘢。'); process.exit(1) }

run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id)
run('DELETE FROM sessions WHERE user_id = ?', user.id)
console.log(`已更新「${user.name}」嘅密碼，請用新密碼登入。`)
rl.close()
process.exit(0)
