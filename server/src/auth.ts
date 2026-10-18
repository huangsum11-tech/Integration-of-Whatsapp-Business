import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { get, run } from './db.js'

export const SESSION_COOKIE = 'baton_session'

export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'agent'
  active: number
  color: string
  style_notes: string
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(password, salt, 64)
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex')
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId)
  return token
}

export function userForToken(token: string | undefined): User | undefined {
  if (!token) return undefined
  return get<User>(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.color, u.style_notes
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND u.active = 1`,
    token,
  )
}

declare global {
  namespace Express {
    interface Request {
      user: User
    }
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = userForToken(req.cookies?.[SESSION_COOKIE])
  if (!user) return res.status(401).json({ error: '請先登入' })
  req.user = user
  next()
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '只限管理員' })
  next()
}
