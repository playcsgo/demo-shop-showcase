import { type FormEvent, useState } from 'react'

export function Composer({ onSend, placeholder, disabled }: { onSend: (body: string) => Promise<boolean>; placeholder?: string; disabled?: boolean }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    if (await onSend(body)) setBody('')
    setSending(false)
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder ?? '輸入訊息'} maxLength={2000} disabled={disabled} />
      <button className="primary" disabled={disabled || sending || !body.trim()}>
        送出
      </button>
    </form>
  )
}
