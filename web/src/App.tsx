import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type User, type WaNumber } from './api'
import { Avatar, Icon, Logo, type IconName } from './components'
import { closeSocket, getSocket } from './socket'
import Customers from './pages/Customers'
import Inbox from './pages/Inbox'
import Marketing from './pages/Marketing'
import Payments from './pages/Payments'
import Payroll from './pages/Payroll'
import Settings from './pages/Settings'
import Today from './pages/Today'

interface AppState {
  me: User
  users: User[]
  numbers: WaNumber[]
  refreshUsers: () => void
  refreshNumbers: () => void
  setMe: (u: User) => void
}

const AppContext = createContext<AppState | null>(null)
export const useApp = () => useContext(AppContext)!

/** Six places: what needs doing today, conversations, customers, promotion, instructors, setup. */
const ROUTES: { path: string; label: string; icon: IconName; admin?: boolean }[] = [
  { path: 'today', label: '今日', icon: 'sun' },
  { path: 'inbox', label: '收件匣', icon: 'inbox' },
  { path: 'customers', label: '客人', icon: 'contacts' },
  { path: 'payments', label: '付款', icon: 'card' },
  { path: 'marketing', label: '推廣', icon: 'megaphone', admin: true },
  { path: 'instructors', label: '導師', icon: 'wallet', admin: true },
  { path: 'settings', label: '設定', icon: 'gear' },
]

/** Addresses from before everything moved into one place keep working. */
const MOVED: Record<string, string> = {
  contacts: 'customers', analytics: 'today/analytics', payroll: 'instructors',
  ai: 'settings/ai', automation: 'settings/automation', numbers: 'settings/channels', team: 'settings/team',
}

function useRoute() {
  const read = () => {
    const parts = window.location.hash.replace(/^#\/?/, '').split('/')
    if (MOVED[parts[0]]) {
      window.location.replace(`#/${MOVED[parts[0]]}`)
      return MOVED[parts[0]].split('/')
    }
    return parts
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined)
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    api<User>('/me').then(setMe).catch(async (err) => {
      if (err instanceof ApiError && err.status === 401) {
        const s = await api<{ needsSetup: boolean }>('/setup')
        setNeedsSetup(s.needsSetup)
        setMe(null)
      }
    })
  }, [])

  if (me === undefined) return null
  if (me === null) return <Auth setup={needsSetup} onDone={() => api<User>('/me').then(setMe)} />
  return <Shell me={me} setMe={setMe} onLogout={() => { closeSocket(); setMe(null) }} />
}

function Shell({ me, setMe, onLogout }: { me: User; setMe: (u: User) => void; onLogout: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [numbers, setNumbers] = useState<WaNumber[]>([])
  const [unread, setUnread] = useState(0)
  const [toCheck, setToCheck] = useState(0)
  const route = useRoute()
  const routes = ROUTES.filter((r) => !r.admin || me.role === 'admin')
  const page = routes.some((r) => r.path === route[0]) ? route[0] : 'today'
  const [menuOpen, setMenuOpen] = useState(false)

  const refreshUsers = useCallback(() => { api<User[]>('/users').then(setUsers) }, [])
  const refreshNumbers = useCallback(() => { api<WaNumber[]>('/numbers').then(setNumbers) }, [])
  const refreshUnread = useCallback(() => {
    api<{ id: number; unread: number }[]>('/conversations?view=all').then((cs) => setUnread(cs.filter((c) => c.unread > 0).length))
    api<{ counts: { verify: number | null; quote: number | null } }>('/payments?status=awaiting_verification').then((p) => setToCheck((p.counts.verify ?? 0) + (p.counts.quote ?? 0))).catch(() => {})
  }, [])

  useEffect(() => {
    refreshUsers(); refreshNumbers(); refreshUnread()
    const socket = getSocket()
    const onNumber = (n: Partial<WaNumber> & { id: number }) =>
      setNumbers((prev) => prev.some((p) => p.id === n.id) ? prev.map((p) => (p.id === n.id ? { ...p, ...n } : p)) : (refreshNumbers(), prev))
    socket.on('number', onNumber)
    socket.on('conversation', refreshUnread)
    socket.on('payment', refreshUnread)
    socket.on('refresh', refreshUsers)
    return () => { socket.off('number', onNumber); socket.off('conversation', refreshUnread); socket.off('payment', refreshUnread); socket.off('refresh', refreshUsers) }
  }, [refreshUsers, refreshNumbers, refreshUnread])

  const logout = async () => { await api('/logout', { method: 'POST' }); onLogout() }

  return (
    <AppContext.Provider value={{ me, users, numbers, refreshUsers, refreshNumbers, setMe }}>
      <div className="shell">
        <nav className="rail" aria-label="主選單">
          <a className="logo" href="#/today" aria-label="Baton 今日"><Logo size={42} /></a>
          {routes.map((r) => (
            <a key={r.path} href={`#/${r.path}`} className={`rail-btn ${page === r.path ? 'active' : ''}`} aria-current={page === r.path ? 'page' : undefined}>
              <Icon name={r.icon} size={21} />
              {r.label}
              {r.path === 'inbox' && unread > 0 && <span className="dot">{unread}</span>}
              {r.path === 'payments' && toCheck > 0 && <span className="dot" aria-label={`${toCheck} 筆待處理`}>{toCheck}</span>}
            </a>
          ))}
          <div className="spacer" />
          <div className="me-menu">
            <button className="rail-btn me-btn" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label={`${me.name}：帳戶選單`}>
              <Avatar name={me.name} color={me.color} size={30} />
              <span className="me-name">{me.name.split(' ')[0]}</span>
            </button>
            {menuOpen && (
              <div className="me-pop" role="menu">
                <div className="me-pop-head"><b>{me.name}</b><span className="muted">{me.email}</span></div>
                <a role="menuitem" href="#/settings/team" onClick={() => setMenuOpen(false)}><Icon name="user" size={16} />我的語氣及資料</a>
                <button role="menuitem" onClick={logout}><Icon name="logout" size={16} />登出</button>
              </div>
            )}
          </div>
        </nav>
        <main className="main">
          {page === 'today' && <Today tab={route[1] === 'analytics' ? 'analytics' : 'today'} />}
          {page === 'inbox' && <Inbox conversationId={route[1] ? Number(route[1]) : null} />}
          {page === 'customers' && <Customers tab={route[1]} />}
          {page === 'marketing' && <Marketing />}
          {page === 'payments' && <Payments />}
          {page === 'instructors' && <Payroll />}
          {page === 'settings' && <Settings section={route[1]} />}
        </main>
      </div>
    </AppContext.Provider>
  )
}

function Auth({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api(setup ? '/setup' : '/login', { body: form })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登入失敗')
    } finally {
      setBusy(false)
    }
  }

  const perks: [IconName, string][] = [
    ['qr', '掃 QR Code 即用，每個號碼約一分鐘連接'],
    ['inbox', '整個團隊在同一處回覆，對話可以交接'],
    ['archive', '訊息、相片、語音與文件自動備份'],
    ['sparkle', 'AI 根據公司知識庫回答客人，不確定就轉交同事'],
    ['instagram', 'WhatsApp、Instagram、Facebook、Threads 集中一處'],
    ['shield', '同事離職時，客戶關係留在公司'],
  ]

  return (
    <div className="auth">
      <section className="auth-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Logo size={44} />
          <b style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Baton 接棒</b>
        </div>
        <div>
          <h1>對話接棒，<br /><span>生意不斷。</span></h1>
          <p>把你現有的 WhatsApp Business 號碼變成團隊共用收件匣。號碼不變，毋須申請 Platform API。</p>
          <ul>{perks.map(([icon, text]) => <li key={text}><Icon name={icon} />{text}</li>)}</ul>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>© Baton 接棒</span>
        <svg className="baton-art" width="420" height="420" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M16 40c0-9 7-16 16-16h8" stroke="#3cc9a0" strokeWidth="5" strokeLinecap="round" fill="none" />
          <path d="M48 24c0 9-7 16-16 16h-8" stroke="#e2583e" strokeWidth="5" strokeLinecap="round" fill="none" />
        </svg>
      </section>
      <section className="auth-form">
        <form onSubmit={submit}>
          <h2>{setup ? '建立管理員帳戶' : '登入'}</h2>
          <p className="muted" style={{ margin: 0 }}>{setup ? '第一位用戶將成為公司管理員。' : '歡迎回來，登入你的團隊收件匣。'}</p>
          {setup && (
            <div><label className="label" htmlFor="name">你的名稱</label>
              <input id="name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          )}
          <div><label className="label" htmlFor="email">電郵</label>
            <input id="email" className="input" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label className="label" htmlFor="password">密碼{setup && '（最少 8 個字元）'}</label>
            <input id="password" className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={setup ? 8 : undefined} /></div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy} style={{ justifyContent: 'center', padding: '10px' }}>{setup ? '建立並開始' : '登入'}</button>
          {!setup && <div className="demo-hint">示範帳戶：karen@baton.demo ／ baton-demo（需先執行 npm run seed）</div>}
        </form>
      </section>
    </div>
  )
}
