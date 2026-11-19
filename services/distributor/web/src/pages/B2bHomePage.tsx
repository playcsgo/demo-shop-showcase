import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { useB2b } from './B2bApp.tsx'
import { BatchesPage } from './BatchesPage.tsx'
import type { Shop } from './types.ts'

export function B2bHomePage() {
  const { me } = useB2b()
  const [shops, setShops] = useState<Shop[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ data: Shop[] }>('/shops').then((r) => setShops(r.data)).catch((e) => setError(e.message))
  }, [])

  return (
    <>
      <h1>{me?.distributor.name}</h1>
      <p className="muted">代碼 {me?.distributor.code}．幣別 {me?.distributor.currency}．角色 {me?.role}</p>
      {error && <p className="error">{error}</p>}
      <p><Link to="/batches/new"><button className="primary">新增叫貨</button></Link></p>
      <BatchesPage />
      <h2>收貨地點</h2>
      {shops?.length === 0 && <p className="muted">還沒有 shop，請聯絡負責的業務。</p>}
      <div className="grid">
        {shops?.map((s) => (
          <div className="card" key={s.id}>
            <h3><Link to={`/shops/${s.id}`}>{s.name}</Link></h3>
            <p className="muted">{s.country_code}．{s.city}</p>
            <p>{s.address}</p>
            {s.destination_port && <p className="muted">目的港：{s.destination_port}</p>}
          </div>
        ))}
      </div>
    </>
  )
}
