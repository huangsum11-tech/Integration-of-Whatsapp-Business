import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../App'
import { Icon } from '../components'

interface Status {
  stage: number; enabled: boolean; switchedOn: boolean; missingEnv: string[]; hasProfile: boolean; headless: boolean
  profile: unknown; example: unknown
}
interface Step { at: number; step: string; ok: boolean; note: string; shot?: string }
interface RunRow { id: number; kind: string; request_id: number | null; user_name: string | null; status: string; target: string; detail: string; log: Step[]; started_at: number }

const RUN_LABEL: Record<string, string> = {
  running: '執行中', awaiting_confirmation: '等同事確認', stopped: '已停止', failed: '失敗', done: '完成',
}
const STEP_LABEL: Record<string, string> = { login: '登入', search: '搜尋會員', form: '套票表格', ready: '停在確認畫面', stopped: '停止', error: '錯誤' }
const time = (t: number) => new Date(t * 1000).toLocaleString('zh-HK', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Booking-system back office, assist mode only: fills the form, a teammate presses confirm. */
export default function Backoffice() {
  const { me } = useApp()
  const admin = me.role === 'admin'
  const [status, setStatus] = useState<Status | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [profile, setProfile] = useState('')
  const [msg, setMsg] = useState('')
  const load = useCallback(() => {
    api<Status>('/backoffice/status').then((s) => {
      setStatus(s)
      setProfile(JSON.stringify(s.profile ?? s.example, null, 2))
    })
    api<{ runs: RunRow[] }>('/backoffice/runs').then((r) => setRuns(r.runs))
  }, [])
  useEffect(() => { load() }, [load])
  if (!status) return null

  const save = async (enabled: boolean) => {
    setMsg('')
    try {
      await api('/backoffice/settings', { method: 'PUT', body: { enabled, profile: JSON.parse(profile) } })
      setMsg('已儲存')
      load()
    } catch (err) {
      setMsg(err instanceof SyntaxError ? '畫面設定不是有效的 JSON，請檢查括號及引號' : err instanceof Error ? err.message : '儲存失敗')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>預約後台輔助</h1>
          <p>付款核實後，系統可以開啟瀏覽器、用專用員工帳戶登入預約後台、搜尋會員並填好「加入套票」表格，然後停在確認畫面。最後一步一定由同事核對及按確認（輔助模式，階段二）。</p>
        </div>
      </div>

      <section className="card ai-card" style={{ marginBottom: 20 }}>
        <div className="ai-card-head"><h2>狀態</h2></div>
        <ul className="bo-status">
          <li className={status.missingEnv.length ? 'todo' : 'ok'}>
            <Icon name={status.missingEnv.length ? 'x' : 'check'} size={16} />
            <span>{status.missingEnv.length ? <>未填寫帳戶：在 <code>.env</code> 加入 {status.missingEnv.join('、')}，然後重新啟動</> : '帳戶已在 .env 設定（密碼不會在這裏顯示）'}</span>
          </li>
          <li className={status.hasProfile ? 'ok' : 'todo'}>
            <Icon name={status.hasProfile ? 'check' : 'x'} size={16} />
            <span>{status.hasProfile ? '已有畫面設定' : '未儲存畫面設定（下面的範本需要按實際後台修改）'}</span>
          </li>
          <li className={status.switchedOn ? 'ok' : 'todo'}>
            <Icon name={status.switchedOn ? 'check' : 'x'} size={16} />
            <span>{status.switchedOn ? '已開啟：付款核實頁會顯示「後台輔助填表」' : '未開啟'}</span>
          </li>
          <li className="ok"><Icon name="shield" size={16} /><span>全自動（自動按確認）未啟用，需要 Sum 另行批准</span></li>
        </ul>
      </section>

      <section className="card ai-card" style={{ marginBottom: 20 }}>
        <div className="ai-card-head"><h2>畫面設定</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>描述後台每一步的按鈕及欄位（CSS 選擇器），不包含任何密碼。後台改版後如果畫面與設定不符，系統會停手並通知同事。每個套票的後台名稱在「品牌及收款 → 套票」填寫。</p>
        <label className="label" htmlFor="bo-profile">畫面設定（JSON）</label>
        <textarea id="bo-profile" className="textarea mono" rows={14} value={profile} disabled={!admin} onChange={(e) => setProfile(e.target.value)} spellCheck={false} />
        {admin && (
          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => save(status.switchedOn)}>儲存畫面設定</button>
            <button className="btn" onClick={() => save(!status.switchedOn)}>{status.switchedOn ? '關閉後台輔助' : '開啟後台輔助'}</button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        )}
      </section>

      <section className="card ai-card">
        <div className="ai-card-head"><h2>執行紀錄</h2></div>
        {runs.length === 0
          ? <p className="faint">未有執行紀錄。在「付款」頁核實付款後按「後台輔助填表」就會在這裏留下紀錄及截圖。</p>
          : (
            <ul className="bo-runs">
              {runs.map((r) => (
                <li key={r.id}>
                  <div className="bo-run-head">
                    <b>#{r.id}</b>
                    <span className={`chip ${r.status === 'stopped' || r.status === 'failed' ? 'coral' : ''}`}>{RUN_LABEL[r.status] ?? r.status}</span>
                    <span className="muted">{time(r.started_at)} · {r.user_name ?? '系統'}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>{r.target}</div>
                  {r.detail && <div style={{ fontSize: 13 }}>{r.detail}</div>}
                  <ol className="bo-steps">
                    {r.log.map((s, i) => (
                      <li key={i} className={s.ok ? '' : 'bad'}>
                        {STEP_LABEL[s.step] ?? s.step}：{s.note}
                        {s.shot && <> · <a href={`/api/backoffice/screenshot?path=${encodeURIComponent(s.shot)}`} target="_blank" rel="noreferrer">截圖</a></>}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
