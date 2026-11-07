import { useApp } from '../App'
import { Icon, type IconName } from '../components'
import Assistant from './Assistant'
import Brands from './Brands'
import Automation from './Automation'
import Numbers from './Numbers'
import Team from './Team'

const SECTIONS: { id: string; label: string; hint: string; icon: IconName }[] = [
  { id: 'channels', label: '渠道', hint: 'WhatsApp、IG、FB、Threads', icon: 'phone' },
  { id: 'brands', label: '品牌及收款', hint: '價目、預約連結、FPS／PayMe', icon: 'card' },
  { id: 'ai', label: 'AI 及知識庫', hint: 'AI 模型、公司資料、預約連結', icon: 'sparkle' },
  { id: 'automation', label: '自動化', hint: '跟進、提醒、報告、快速回覆', icon: 'clock' },
  { id: 'team', label: '團隊', hint: '同事、交接、語氣', icon: 'team' },
]

/** Everything that is set up once and then left alone, in one place. */
export default function Settings({ section }: { section?: string }) {
  const { me } = useApp()
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  return (
    <div className="hub">
      <nav className="hub-nav" aria-label="設定">
        <h1>設定</h1>
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#/settings/${s.id}`} className={`hub-link ${s.id === current.id ? 'active' : ''}`} aria-current={s.id === current.id ? 'page' : undefined}>
            <Icon name={s.icon} size={18} />
            <span><b>{s.label}</b><small>{s.hint}</small></span>
          </a>
        ))}
        {me.role !== 'admin' && <p className="faint hub-note">只有管理員可以修改設定。</p>}
      </nav>
      <div className="hub-body">
        {current.id === 'channels' && <Numbers />}
        {current.id === 'brands' && <Brands />}
        {current.id === 'ai' && <Assistant />}
        {current.id === 'automation' && <Automation />}
        {current.id === 'team' && <Team />}
      </div>
    </div>
  )
}
