import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { TrialsCard } from './Automation'
import Contacts from './Contacts'
import { CustomerImport } from './Marketing'

const TABS = [
  { id: 'all', label: '聯絡簿' },
  { id: 'trials', label: '試堂' },
  { id: 'import', label: '標籤及匯入', admin: true },
]

/** Every customer from every channel, their trial classes, and their tags. */
export default function Customers({ tab }: { tab?: string }) {
  const { me } = useApp()
  const tabs = TABS.filter((t) => !t.admin || me.role === 'admin')
  const current = tabs.find((t) => t.id === tab)?.id ?? 'all'
  return (
    <div className="area">
      <div className="area-tabs" role="tablist" aria-label="客人">
        {tabs.map((t) => (
          <a key={t.id} role="tab" aria-selected={t.id === current} className={`area-tab ${t.id === current ? 'active' : ''}`} href={`#/customers/${t.id}`}>{t.label}</a>
        ))}
      </div>
      <div className="area-body">
        {current === 'all' && <Contacts />}
        {current === 'trials' && <Trials />}
        {current === 'import' && <div className="page"><CustomerImport /></div>}
      </div>
    </div>
  )
}

function Trials() {
  const [trials, setTrials] = useState<Parameters<typeof TrialsCard>[0]['trials'] | null>(null)
  useEffect(() => { api<{ trials: Parameters<typeof TrialsCard>[0]['trials'] }>('/automation').then((d) => setTrials(d.trials)) }, [])
  if (!trials) return null
  return <div className="page"><div className="narrow"><TrialsCard trials={trials} /></div></div>
}
