import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { batchStatusLabel, type Batch, formatMoney, ORDER_TYPE } from './types.ts'

export function BatchesPage() {
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { api<{ data: Batch[] }>('/batches').then((r) => setBatches(r.data)).catch((e) => setError(e.message)) }, [])

  return (
    <>
      <h2>我的批次</h2>
      {error && <p className="error">{error}</p>}
      {batches?.length === 0 && <p className="muted">還沒有送出過。</p>}
      {!!batches?.length && (
        <table>
          <thead><tr><th>批次</th><th>類型</th><th>狀態</th><th>金額</th><th>預計回覆日</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.batch_no}>
                <td><Link to={`/batches/${b.batch_no}`}>{b.batch_no}</Link></td>
                <td>{ORDER_TYPE[b.order_type]}</td>
                <td>{batchStatusLabel(b.status, b.order_type)}</td>
                <td>{formatMoney(b.total_minor, b.currency)}</td>
                <td>{b.anticipated_response_date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
