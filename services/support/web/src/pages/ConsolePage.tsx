import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { api, ApiError, connect, emit, type Message, mergeMessages, post } from '../api.ts'
import { Composer } from './Composer.tsx'
import { DemoPanel } from './DemoPanel.tsx'
import { ProposalCards } from './ProposalCards.tsx'
import { TracePanel } from './TracePanel.tsx'
import { MessageList } from './MessageList.tsx'

interface Staff {
  id: number
  name: string
  role: 'support_agent' | 'vet'
}
interface Summary {
  id: string
  status?: 'queued' | 'pending'
  flagged_attack?: boolean
  reason_code?: string | null
  mode: 'ask' | 'human'
  customer_name: string
  created_at: string
}

export function ConsolePage() {
  const [staff, setStaff] = useState<Staff | null | undefined>(undefined)

  useEffect(() => {
    api<Staff>('/auth/staff/me').then(setStaff, () => setStaff(null))
  }, [])

  if (staff === undefined) return null
  if (!staff) return <StaffLogin onLogin={setStaff} />
  return (
    <Console
      staff={staff}
      onLogout={async () => {
        await post('/auth/staff/logout')
        setStaff(null)
      }}
    />
  )
}

function StaffLogin({ onLogin }: { onLogin: (s: Staff) => void }) {
  const [email, setEmail] = useState('support@example.test')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      onLogin(await post<Staff>('/auth/staff/login', { email, password }))
    } catch {
      setError('帳號或密碼錯誤')
    }
  }

  return (
    <main className="page">
      <form className="card narrow" onSubmit={submit}>
        <h2>客服控制台</h2>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label>
          密碼
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <button className="primary">登入</button>
        {error && <p className="error">{error}</p>}
        <p className="hint">demo 帳號：support@example.test（客服）、vet@example.test（獸醫），密碼 0204</p>
      </form>
    </main>
  )
}

function Console({ staff, onLogout }: { staff: Staff; onLogout: () => void }) {
  const [queue, setQueue] = useState<Summary[]>([])
  const [mine, setMine] = useState<Summary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [socket, setSocket] = useState<ReturnType<typeof connect> | null>(null)
  const [note, setNote] = useState(false)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [joinOn, setJoinOn] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const [q, m] = await Promise.all([api<Summary[]>('/console/queue'), api<Summary[]>('/console/conversations')])
    setQueue(q)
    setMine(m)
  }, [])

  useEffect(() => {
    const s = connect('/staff')
    s.on('queue', () => void refresh())
    s.on('disconnect', () => setError('連線中斷，重新連線中'))
    s.on('connect', () => setError(''))
    setSocket(s)
    void refresh()
    return () => {
      s.close()
    }
  }, [refresh])

  useEffect(() => {
    if (!socket || !selected) return
    let alive = true // 切到別段對話後，還在路上的舊紀錄不能混進來
    setMessages([])
    setDraft('')
    setThinking(false)
    setJoinOn(false)
    setJoinError('')
    const onMessage = (m: Message) => alive && m.conversation_id === selected && setMessages((list) => mergeMessages(list, m))
    const onDelta = (e: { text: string }) => alive && setDraft((d) => d + e.text)
    // 串流結束到回答存好之間還有一點空檔，這時不能再冒出輸入中
    const onEnd = () => {
      setDraft('')
      setThinking(false)
    }
    const onThinking = (e: { active: boolean }) => alive && setThinking(e.active)
    const onJoinError = (e: { message: string }) => alive && setJoinError(e.message)
    // 重新連線後伺服器上的房間已經不在了，每次連上都要重新加入
    const join = () => void emit(socket, 'join', { conversationId: selected })
    socket.on('message', onMessage)
    socket.on('ask:delta', onDelta)
    socket.on('ask:end', onEnd)
    socket.on('ask:thinking', onThinking)
    socket.on('join:error', onJoinError)
    socket.on('connect', join)
    join()
    api<Message[]>(`/console/conversations/${selected}/messages`).then(
      (history) => alive && setMessages((list) => history.filter((m) => m.conversation_id === selected).reduce(mergeMessages, list)),
    )
    return () => {
      alive = false
      socket.off('message', onMessage)
      socket.off('ask:delta', onDelta)
      socket.off('ask:end', onEnd)
      socket.off('ask:thinking', onThinking)
      socket.off('join:error', onJoinError)
      socket.off('connect', join)
    }
  }, [socket, selected])

  async function take(id: string) {
    setError('')
    try {
      await post(`/console/conversations/${id}/assign`)
      await refresh()
      setSelected(id)
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? '已經被別人接走了' : '接手失敗')
      await refresh()
    }
  }

  /** 刪除＝結束並從列表隱藏（AIC-019）：客戶那邊收到「對話已結束」；紀錄都留著，只是控制台不再列出 */
  async function remove(id: string) {
    if (!confirm('刪除後這段對話會結束，從「我的對話」消失，客戶也不能再傳訊息。紀錄仍會保存。確定嗎？')) return
    setError('')
    try {
      await api(`/console/conversations/${id}`, { method: 'DELETE' })
      setSelected(null)
    } catch {
      setError('刪除失敗')
    }
    await refresh()
  }

  async function send(body: string) {
    if (!socket || !selected) return false
    const ack = await emit(socket, note ? 'note' : 'send', { conversationId: selected, body }).catch(() => ({ ok: false }))
    if (!ack.ok) setError('訊息沒送出')
    return ack.ok
  }

  async function toggleJoin(on: boolean) {
    if (!socket || !selected) return
    const ack = await emit(socket, 'join:toggle', { conversationId: selected, on }).catch(() => ({ ok: false }))
    if (ack.ok) setJoinOn(on)
    else setError('Join 開關失敗')
  }

  async function askAi(question: string) {
    if (!socket || !selected) return false
    const ack = await emit(socket, 'ask', { conversationId: selected, question }).catch(() => ({ ok: false }))
    if (!ack.ok) setError('AI 問不了')
    return ack.ok
  }

  const time = (s: string) => new Date(s).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })

  return (
    <>
      <header className="top">
        <span className="logo">客服控制台</span>
        <span>
          {staff.name}（{staff.role === 'vet' ? '獸醫' : '客服'}）　<button className="link" onClick={onLogout}>登出</button>
        </span>
      </header>
      <main className="console">
        <aside>
          <DemoPanel />
          <h3>等待中（{queue.length}）</h3>
          {queue.length === 0 && <p className="hint">目前沒有人在等</p>}
          {queue.map((c) => (
            <div key={c.id} className="item">
              <span>
                {c.customer_name}
                <small className="muted">　{time(c.created_at)}</small>
                {c.status === 'pending' && <span className="badge">待回覆</span>}
                {c.flagged_attack && <span className="badge danger">疑似套取資料</span>}
              </span>
              <button onClick={() => take(c.id)}>接手</button>
            </div>
          ))}
          <h3>我的對話</h3>
          {mine.map((c) => (
            <button key={c.id} className={`item conv ${c.id === selected ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
              {c.customer_name}
              <small className="muted">　{time(c.created_at)}</small>
            </button>
          ))}
        </aside>
        <section>
          {selected ? (
            <>
              <div className="conv-actions">
                <button className="link danger" onClick={() => remove(selected)}>刪除這段對話</button>
              </div>
              <HandoffInfo conversationId={selected} />
              <label className="note-toggle">
                <input type="checkbox" checked={joinOn} onChange={(e) => toggleJoin(e.target.checked)} /> Join：AI 在旁邊看對話，該說話時給你建議（客戶看不到）
              </label>
              {joinError && <p className="hint">{joinError}</p>}
              <MessageList messages={messages} mine="agent" draft={draft} thinking={thinking} />
              <ProposalCards conversationId={selected} socket={socket} />
              <TracePanel key={selected} conversationId={selected} />
              <Composer onSend={askAi} placeholder="問 AI（只有你看得到）" />
              <label className="note-toggle">
                <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} /> 內部備註（客戶看不到）
              </label>
              <Composer onSend={send} placeholder={note ? '內部備註' : '回覆客戶'} />
            </>
          ) : (
            <p className="hint">從左邊接手或選一段對話</p>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    </>
  )
}

const REASON: Record<string, string> = {
  attack: '疑似套取資料',
  wants_human: '客戶想找真人',
  upset: '客戶不滿',
  medical: '醫療問題',
  router_failed: 'AI 沒把握',
  ai_transfer: 'AI 轉接',
  ai_error: 'AI 查詢出錯',
}

/** AC-16：轉接原因和摘要，客戶不用重講 */
function HandoffInfo({ conversationId }: { conversationId: string }) {
  const [info, setInfo] = useState<{ reason_code?: string; summary?: string | null; flagged_attack?: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    api(`/console/conversations/${conversationId}/handoff`).then((i) => alive && setInfo(i), () => alive && setInfo(null))
    return () => {
      alive = false
    }
  }, [conversationId])
  if (!info?.reason_code) return null
  return (
    <div className={`handoff ${info.flagged_attack ? 'danger' : ''}`}>
      <strong>轉接原因：{REASON[info.reason_code] ?? info.reason_code}</strong>
      <p>{info.summary ?? '（沒有摘要）'}</p>
    </div>
  )
}
