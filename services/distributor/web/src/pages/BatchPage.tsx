import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { BatchSummary } from './BatchSummary.tsx'
import { batchStatusLabel, type Batch, formatMoney, ORDER_TYPE, type Revision } from './types.ts'

export function BatchPage() {
  const { batchNo } = useParams()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    api<Batch>(`/batches/${batchNo}`).then(setBatch).catch((e) => setError(e.message))
    api<{ data: Revision[] }>(`/batches/${batchNo}/revisions`).then((r) => setRevisions(r.data)).catch(() => {})
  }, [batchNo])

  if (error) return <p className="error">{error}</p>
  if (!batch) return <p className="muted">載入中…</p>

  return (
    <>
      <p><Link to="/">← 回到總覽</Link></p>
      <h1>{batch.batch_no}</h1>
      <p><span className="badge">{batchStatusLabel(batch.status, batch.order_type)}</span> {ORDER_TYPE[batch.order_type]}．第 {batch.revision} 次送出</p>
      {batch.status === 'IN_REVIEW' && <p className="muted">預計回覆日：{batch.anticipated_response_date}</p>}
      {batch.status === 'REJECTED' && (
        <div className="card">
          <p className="error">退回原因：{batch.reject_reason}</p>
          <Link to={`/batches/${batch.batch_no}/edit`}><button className="primary">編輯後重新送出</button></Link>
        </div>
      )}
      <BatchSummary orderType={batch.order_type} orders={batch.orders} currency={batch.currency} total={batch.total_minor} prepay={batch.prepay_minor}
        prepayBps={batch.prepay_bps} moq={batch.moq_results} warnings={batch.warnings} />
      {revisions.length > 1 && (
        <>
          <h2>歷次送出</h2>
          <table>
            <thead><tr><th>次</th><th>類型</th><th>金額</th><th>退回原因</th></tr></thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.revision}>
                  <td>{r.revision}</td>
                  <td>{ORDER_TYPE[r.order_type]}</td>
                  <td>{formatMoney(r.total_minor, batch.currency)}</td>
                  <td>{r.reject_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
