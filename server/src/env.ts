/**
 * Load settings from a .env file (project root, or the server folder) before anything
 * else reads process.env. Variables already set in the environment win.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
for (const file of [path.resolve(here, '../../.env'), path.resolve(here, '../.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file)
}
