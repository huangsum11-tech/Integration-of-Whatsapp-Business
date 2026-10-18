import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type User, type WaNumber } from './api'
import { Icon, Logo, type IconName } from './components'
import { closeSocket, getSocket } from './socket'
import Analytics from './pages/Analytics'
import Contacts from './pages/Contacts'
import Inbox from './pages/Inbox'
import Numbers from './pages/Numbers'
import Team from './pages/Team'

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

const ROUTES: { path: string; label: string; icon: IconName }[] = [
  { path: 'inbox', label: '收件匣', icon: 'inbox' },
  { path: 'contacts', label: '聯絡簿', icon: 'contacts' },
  { path: 'analytics', label: '分析', icon: 'chart' },
  { path: 'numbers', label: '號碼', icon: 'phone' },
  { path: 'team', label: '團隊', icon: 'team' },
]

function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/')
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
  const route = useRoute()
  const page = ROUTES.some((r) => r.path === route[0]) ? route[0] : 'inbox'

  const refreshUsers = useCallback(() => { api<User[]>('/users').then(setUsers) }, [])
  const refreshNumbers = useCallback(() => { api<WaNumber[]>('/numbers').then(setNumbers) }, [])
  const refreshUnread = useCallback(() => {
    api<{ id: number; unread: number }[]>('/conversations?view=all').then((cs) => setUnread(cs.filter((c) => c.unread > 0).length))
  }, [])

  useEffect(() => {
    refreshUsers(); refreshNumbers(); refreshUnread()
    const socket = getSocket()
    const onNumber = (n: Partial<WaNumber> & { id: number }) =>
      setNumbers((prev) => prev.some((p) => p.id === n.id) ? prev.map((p) => (p.id === n.id ? { ...p, ...n } : p)) : (refreshNumbers(), prev))
    socket.on('number', onNumber)
    socket.on('conversation', refreshUnread)
    socket.on('refresh', refreshUsers)
    return () => { socket.off('number', onNumber); socket.off('conversation', refreshUnread); socket.off('refresh', refreshUsers) }
  }, [refreshUsers, refreshNumbers, refreshUnread])

  const logout = async () => { await api('/logout', { method: 'POST' }); onLogout() }

  return (
    <AppContext.Provider value={{ me, users, numbers, refreshUsers, refreshNumbers, setMe }}>
      <div className="shell">
        <nav className="rail" aria-label="主選單">
          <div className="logo"><Logo size={42} /></div>
          {ROUTES.map((r) => (
            <a key={r.path} href={`#/${r.path}`} className={`rail-btn ${page === r.path ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
              <Icon name={r.icon} size={21} />
              {r.label}
              {r.path === 'inbox' && unread > 0 && <span className="dot">{unread}</span>}
            </a>
          ))}
          <div className="spacer" />
          <button className="rail-btn" onClick={logout} title={`${me.name} — 登出`}>
            <Icon name="logout" size={20} />
            登出
          </button>
        </nav>
        <main className="main">
          {page === 'inbox' && <Inbox conversationId={route[1] ? Number(route[1]) : null} />}
          {page === 'contacts' && <Contacts />}
          {page === 'analytics' && <Analytics />}
          {page === 'numbers' && <Numbers />}
          {page === 'team' && <Team />}
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
    ['sparkle', 'AI 以每位同事的語氣草擬回覆'],
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
