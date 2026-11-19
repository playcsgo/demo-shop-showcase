import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { api, ApiError, post } from '../api.ts'

interface Proposal {
  id: string
  status: 'pending' | 'approving' | 'refund_pending' | 'executed' | 'refund_failed' | 'refund_timeout' | 'rejected_by_shop' | 'rejected'
  judgment: string
  reason: string
  params_json: { order_no: string }
  preview_json: { eligible: boolean; amount?: number; code?: string }
  result_json: { amount?: number; code?: string; order_status?: string } | null
}

const STATUS: Record<Proposal['status'], string> = {
  pending: '待核准',
  approving: '處理中',
  refund_pending: '退款處理中', // 商店接受了，等金流（AIC-016）
  executed: '已退款',
  refund_failed: '退款失敗',
  refund_timeout: '請到後台確認',
  rejected_by_shop: '系統擋下',
  rejected: '已拒絕',
}

/** AC-12：AI 提出的退款提案，客服按核准才執行；金額由系統算 */
export function ProposalCards({ conversationId, socket }: { conversationId: string; socket: Socket | null }) {
  const [list, setList] = useState<Proposal[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(
    () => api<Proposal[]>(`/console/conversations/${conversationId}/proposals`).then(setList, () => setList([])),
    [conversationId],
  )

  useEffect(() => {
    void refresh()
    const onProposal = (p: Proposal & { conversation_id: string }) => p.conversation_id === conversationId && void refresh()
    socket?.on('proposal', onProposal)
    return () => {
      socket?.off('proposal', onProposal)
    }
  }, [conversationId, socket, refresh])

  async function decide(id: string, action: 'approve' | 'reject') {
    setError('')
    try {
      await post(`/console/proposals/${id}/${action}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失敗')
    }
    await refresh()
  }

  if (!list.length) return null
  return (
    <div className="proposals">
      {list.map((p) => (
        <div key={p.id} className={`proposal ${p.status}`}>
          <strong>
            退款提案：{p.params_json.order_no}　<span className="badge">{STATUS[p.status]}</span>
          </strong>
          <p>
            AI 判斷：{p.judgment}（{p.reason}）
          </p>
          <p>
            系統計算金額：{p.preview_json.amount ?? '—'} 元{!p.preview_json.eligible && `，系統預檢：${p.preview_json.code}`}
          </p>
          {p.status === 'rejected_by_shop' && <p className="error">系統擋下：{p.result_json?.code}</p>}
          {p.status === 'refund_pending' && <p className="hint">商店已接受，等金流確認（通常幾秒）</p>}
          {p.status === 'executed' && p.result_json?.order_status && <p className="hint">訂單狀態：{p.result_json.order_status}</p>}
          {p.status === 'refund_failed' && <p className="error">金流退款失敗，請到商店後台處理</p>}
          {p.status === 'refund_timeout' && <p className="error">兩分鐘還沒有金流結果，請到商店後台確認這筆退款</p>}
          {/* 執行途中出錯會停在處理中：30 秒後可以重試，同一個冪等鍵不會重複退款 */}
          {p.status === 'approving' && (
            <div className="row">
              <button onClick={() => decide(p.id, 'approve')}>重試核准</button>
            </div>
          )}
          {p.status === 'pending' && (
            <div className="row">
              <button className="primary" onClick={() => decide(p.id, 'approve')}>
                核准退款
              </button>
              <button onClick={() => decide(p.id, 'reject')}>拒絕</button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
