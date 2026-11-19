import { useEffect, useRef } from 'react'
import type { Message } from '../api.ts'

const LABEL: Record<Message['sender'], string> = { customer: '客戶', agent: '客服', ai: 'AI 助理', system: '系統' }

/** mine：從誰的角度看，自己的訊息靠右。draft：AI 正在串流、還沒存好的回答。thinking：AI 還在想，第一個字出來前顯示輸入中 */
export function MessageList({
  messages,
  mine,
  draft,
  thinking,
}: {
  messages: Message[]
  mine: Message['sender']
  draft?: string
  thinking?: boolean
}) {
  const end = useRef<HTMLDivElement>(null)
  // 加大括號：新版瀏覽器的 scrollIntoView 會回傳 Promise，React 會把它當成清理函式
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, draft, thinking])

  return (
    <div className="messages">
      {messages.length === 0 && !draft && <p className="hint">還沒有訊息</p>}
      {messages.map((m) => (
        <div key={m.id} className={`bubble ${m.sender === mine ? 'mine' : ''} ${m.visibility === 'internal' ? 'internal' : ''}`}>
          <span className="who">
            {m.sender === mine ? '我' : LABEL[m.sender]}
            {m.visibility === 'internal' && '・內部'}
          </span>
          {m.attachment_key === 'warning' ? (
            <p className="warning">⚠️ {m.body}</p>
          ) : m.attachment_key ? (
            <img className="attachment" src={`/api/assets/${m.attachment_key}`} alt={m.body} />
          ) : (
            <p>{m.body}</p>
          )}
          {m.refs_json && <Refs refs={m.refs_json} />}
          <time>{new Date(m.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      ))}
      {draft && (
        <div className="bubble draft">
          <span className="who">AI 助理・回答中</span>
          <p>{draft}</p>
        </div>
      )}
      {thinking && !draft && (
        <div className="bubble typing" role="status" aria-label="AI 助理輸入中">
          <span />
          <span />
          <span />
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

/** 引用：回答時工具查到的資料，點開看原始內容 */
function Refs({ refs }: { refs: Record<string, unknown> }) {
  return (
    <div className="refs">
      {Object.entries(refs).map(([key, data]) => (
        <details key={key}>
          <summary>資料來源：{key}</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      ))}
    </div>
  )
}
