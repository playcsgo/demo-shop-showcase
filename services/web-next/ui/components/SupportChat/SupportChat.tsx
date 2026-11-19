'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMe } from '@/ui/shell.tsx'
import { ChatPanel } from './ChatPanel.tsx'
import { type Identity, loadSaved, saveChat, supportPost, whoOf } from './support-api.ts'

type Stage = 'checking' | 'entry' | 'chat' | 'unavailable'
type Mode = 'ask' | 'human'

const MODES: Array<{ mode: Mode; label: string; who: string }> = [
  { mode: 'ask', label: '隨便逛逛', who: 'AI 助理' },
  { mode: 'human', label: '叫你們經理出來', who: '真人客服' },
]

/**
 * 右下角的客服按鈕 + 對話框（AIC-018）。掛在 App 的最外層，換頁不會卸載，所以不斷線。
 * 客服服務沒開時只有這個元件顯示「暫時無法使用」，商店其他功能不受影響
 */
export function SupportChat() {
  const { me } = useMe()
  const [open, setOpen] = useState(false)
  const [big, setBig] = useState(false) // 放大：對話長的時候看得多一點；關掉再打開保持原本的大小
  const [stage, setStage] = useState<Stage>('checking')
  const [convId, setConvId] = useState<string | null>(() => loadSaved()?.id ?? null)
  const [mode, setMode] = useState<Mode | null>(() => loadSaved()?.mode ?? null)
  const panel = useRef<HTMLElement>(null)
  const fab = useRef<HTMLButtonElement>(null)

  // 鍵盤（AIC-019）：打開時焦點移進對話框；Esc 或「關閉」關掉後回到客服按鈕
  useEffect(() => { if (open) panel.current?.focus() }, [open])
  function close() {
    setOpen(false)
    fab.current?.focus()
  }

  /** 開 session（沒登入也要有，對話綁在它身上），再開一段對話 */
  const start = useCallback(async (mode: Mode) => {
    try {
      const who = whoOf(await supportPost<Identity>('/auth/customer/session'))
      const conv = await supportPost<{ id: string }>('/conversations', { mode })
      saveChat({ id: conv.id, who, mode })
      setConvId(conv.id)
      setMode(mode)
      setStage('chat')
    } catch {
      setStage('unavailable')
    }
  }, [])

  // 打開時、登入狀態變了時：確認身分。換了帳號（含登入、登出）→ 舊對話作廢，用同樣的方式開一段新的（AIC-015）
  useEffect(() => {
    if (!open) return
    let alive = true
    supportPost<Identity>('/auth/customer/session').then(
      (identity) => {
        if (!alive) return
        const saved = loadSaved()
        if (saved && saved.who === whoOf(identity)) {
          setConvId(saved.id)
          setMode(saved.mode)
          setStage('chat')
        } else if (saved) {
          saveChat(null)
          setConvId(null)
          void start(saved.mode)
        } else {
          setStage('entry')
        }
      },
      () => alive && setStage('unavailable'),
    )
    return () => {
      alive = false
    }
  }, [open, me?.email, start])

  const lost = useCallback(() => {
    saveChat(null)
    setConvId(null)
    setStage('entry')
  }, [])

  return (
    <>
      {open && (
        <section ref={panel} tabIndex={-1} className={`sc-panel${big ? ' big' : ''}`} role="dialog" aria-label="客服" onKeyDown={(e) => e.key === 'Escape' && close()}>
          <header>
            <strong>Demo Shop 客服</strong>
            <span className="sc-tools">
              {/* 手機本來就全螢幕，這顆只在桌機、平板出現（index.css） */}
              <button className="link sc-size" onClick={() => setBig((b) => !b)} aria-pressed={big}>
                {big ? '縮小' : '放大'}
              </button>
              <button className="link" onClick={close} aria-label="關閉客服">
                關閉
              </button>
            </span>
          </header>
          {stage === 'checking' && <p className="hint sc-note">連線中…</p>}
          {stage === 'unavailable' && <p className="sc-note">客服暫時無法使用，請稍後再試。</p>}
          {stage === 'entry' && (
            <div className="sc-entries">
              <p>有什麼可以幫你？</p>
              {MODES.map((m) => (
                <button key={m.mode} className={`sc-entry${m.mode === 'human' ? ' primary' : ''}`} onClick={() => start(m.mode)}>
                  <strong>{m.label}</strong>
                  <small>{m.who}</small>
                </button>
              ))}
            </div>
          )}
          {stage === 'chat' && convId && (
            <>
              {/* 切換模式、清空（AIC-019）：只改前台，都是開一段新的對話；舊對話留在伺服器（AC-25 保存），畫面上不再顯示 */}
              <div className="sc-modes" role="group" aria-label="對話對象">
                {MODES.map((m) => (
                  <button key={m.mode} aria-pressed={m.mode === mode} disabled={m.mode === mode} onClick={() => start(m.mode)}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode && (
                <button className="link sc-clear" onClick={() => confirm('清空後會開一段新的對話，現在的訊息不會再顯示。確定嗎？') && start(mode)}>
                  清空對話
                </button>
              )}
              <ChatPanel key={convId} id={convId} onLost={lost} />
            </>
          )}
        </section>
      )}
      <button ref={fab} className="sc-fab primary" onClick={() => setOpen((o) => !o)} aria-label={open ? '關閉客服' : '客服'} aria-expanded={open}>
        {open ? '關閉' : '客服'}
      </button>
    </>
  )
}

