'use client'

import { useEffect, useState } from 'react'
import { Link, useLocation } from '@/ui/router.tsx'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'
import { connectCustomer, emit, mergeMessages, type Message, supportApi } from './support-api.ts'

/** 一段對話：歷史紀錄 + 即時推送（串流、輸入中、請登入）。換頁不會卸載，所以不斷線 */
export function ChatPanel({ id, onLost }: { id: string; onLost: () => void }) {
  const location = useLocation()
  const [messages, setMessages] = useState<Message[]>([])
  const [socket, setSocket] = useState<ReturnType<typeof connectCustomer> | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [askLogin, setAskLogin] = useState(false)

  useEffect(() => {
    let alive = true
    setMessages([])
    supportApi<Message[]>(`/conversations/${id}/messages`).then(
      (history) => alive && setMessages((list) => history.reduce(mergeMessages, list)),
      () => alive && onLost(), // 找不到或沒有權限（例如換帳號、服務重置）：回到入口
    )
    const s = connectCustomer()
    s.on('message', (m: Message) => m.conversation_id === id && setMessages((list) => mergeMessages(list, m)))
    // AI 的回答先串流成草稿，存好後以一般訊息送來
    s.on('ask:delta', (e: { text: string }) => setDraft((d) => d + e.text))
    // 串流結束到回答存好之間還有一點空檔，這時不能再冒出輸入中
    s.on('ask:end', () => {
      setDraft('')
      setThinking(false)
    })
    s.on('ask:thinking', (e: { active: boolean }) => setThinking(e.active))
    s.on('ask:login', () => setAskLogin(true))
    // 重新連線後伺服器上的房間已經不在了，每次連上都要重新加入
    s.on('connect', () => emit(s, 'join', { conversationId: id }).then((ack) => alive && setError(ack.ok ? '' : '連不上這段對話')))
    s.on('disconnect', () => alive && setError('連線中斷，重新連線中'))
    setSocket(s)
    return () => {
      alive = false
      s.close()
    }
  }, [id, onLost])

  async function send(body: string) {
    if (!socket) return false
    const ack = await emit(socket, 'send', { conversationId: id, body }).catch(() => ({ ok: false, error: 'timeout' }))
    // 客服刪掉（結束）的對話不收訊息（AIC-019）：叫客戶清空，開一段新的
    if (!ack.ok) setError(ack.error === 'closed' ? '這段對話已結束，按「清空對話」開一段新的' : '訊息沒送出')
    return ack.ok
  }

  return (
    <>
      <MessageList messages={messages} draft={draft} thinking={thinking} />
      {askLogin && (
        <p className="sc-login">
          要查訂單請先 <Link to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>登入</Link>，登入後會開一段新的對話。
        </p>
      )}
      {error && <p className="error sc-error">{error}</p>}
      <Composer onSend={send} disabled={!!error} />
    </>
  )
}
