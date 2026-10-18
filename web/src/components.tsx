import type { ReactNode, SVGProps } from 'react'
import { colorFor, initials } from './format'

const PATHS: Record<string, ReactNode> = {
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  contacts: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M7 16V11" /><path d="M12 16V7" /><path d="M17 16v-4" /></>,
  phone: <><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" /></>,
  team: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  sparkle: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>,
  handoff: <><path d="M17 3l4 4-4 4" /><path d="M3 7h18" /><path d="M7 21l-4-4 4-4" /><path d="M21 17H3" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <><path d="M18 6 6 18" /><path d="M6 6l12 12" /></>,
  note: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h5" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  archive: <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  trophy: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>,
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  )
}

export function Avatar({ name, color, size = 36 }: { name: string; color?: string; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: color ?? colorFor(name) }}>
      {initials(name)}
    </div>
  )
}

/** Two batons passing between hands: the Baton mark. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Baton 接棒">
      <rect width="64" height="64" rx="16" fill="#1d2f2a" />
      <path d="M16 40c0-9 7-16 16-16h8" stroke="#3cc9a0" strokeWidth="7" strokeLinecap="round" fill="none" />
      <path d="M48 24c0 9-7 16-16 16h-8" stroke="#e2583e" strokeWidth="7" strokeLinecap="round" fill="none" />
    </svg>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function NumberStatus({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    connected: ['pine', '已連接'],
    demo: ['iris', '示範號碼'],
    qr: ['coral', '等待掃描'],
    starting: ['', '啟動中'],
    reconnecting: ['coral', '重新連接中'],
    logged_out: ['coral', '已登出'],
    unlinked: ['', '已解除連結'],
    disconnected: ['', '未連接'],
  }
  const [tone, label] = map[status] ?? ['', status]
  return <span className={`chip ${tone}`}><span className="led" />{label}</span>
}
