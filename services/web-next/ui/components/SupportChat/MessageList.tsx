'use client'

import { useEffect, useRef } from 'react'
import { assetUrl, type Message } from './support-api.ts'

const LABEL: Record<Message['sender'], string> = { customer: '我', agent: '客服', ai: 'AI 助理', system: '系統' }

/** draft：AI 正在串流、還沒存好的回答。thinking：第一個字出來前顯示輸入中 */
export function MessageList({ messages, draft, thinking }: { messages: Message[]; draft: string; thinking: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, draft, thinking])

  return (
    <div className="sc-messages">
      {messages.length === 0 && !draft && <p className="hint">還沒有訊息</p>}
      {messages
        .filter((m) => m.visibility === 'public')
        .map((m) => (
          <div key={m.id} className={`sc-bubble ${m.sender === 'customer' ? 'mine' : ''}`}>
            <span className="who">{LABEL[m.sender]}</span>
            {m.attachment_key === 'warning' ? (
              <p className="sc-warning">{m.body}</p>
            ) : m.attachment_key ? (
              <img className="sc-attachment" src={assetUrl(m.attachment_key)} alt={m.body} />
            ) : (
              <p>{m.body}</p>
            )}
            {m.refs_json && <Refs refs={m.refs_json} />}
          </div>
        ))}
      {draft && (
        <div className="sc-bubble draft">
          <span className="who">AI 助理・回答中</span>
          <p>{draft}</p>
        </div>
      )}
      {thinking && !draft && (
        <div className="sc-bubble typing" role="status" aria-label="AI 助理輸入中">
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
    <div className="sc-refs">
      {Object.entries(refs).map(([key, data]) => (
        <details key={key}>
          <summary>資料來源：{key}</summary>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </details>
      ))}
    </div>
  )
}
