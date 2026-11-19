import { createContext, useContext, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { B2bLoginPage } from './B2bLoginPage.tsx'
import { B2bHomePage } from './B2bHomePage.tsx'
import { BatchPage } from './BatchPage.tsx'
import { NewBatchPage } from './NewBatchPage.tsx'
import { OrderTimelinePage } from './OrderTimelinePage.tsx'
import { ShopCatalogPage } from './ShopCatalogPage.tsx'
import { ShopItemsPage } from './ShopItemsPage.tsx'

export type B2bMe = { name: string; email: string; role: 'manager' | 'buyer'; distributor: { code: string; name: string; currency: string } }
type Ctx = { me: B2bMe | null; setMe: (m: B2bMe | null) => void }
const B2bContext = createContext<Ctx>({ me: null, setMe: () => {} })
export const useB2b = () => useContext(B2bContext)

/** 經銷商前台：登入狀態和導覽 */
export function B2bApp() {
  const [me, setMe] = useState<B2bMe | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => { api<B2bMe>('/me').then(setMe).catch(() => setMe(null)).finally(() => setLoading(false)) }, [])

  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    setMe(null)
    navigate('/login')
  }

  if (loading) return <main className="page"><p className="muted">載入中…</p></main>

  return (
    <B2bContext.Provider value={{ me, setMe }}>
      <header className="top">
        <Link to="/" className="logo">經銷商專區</Link>
        {me && <nav><span>{me.distributor.name}（{me.name}）</span><button className="link" onClick={logout}>登出</button></nav>}
      </header>
      <main className="page">
        <Routes>
          <Route path="login" element={me ? <Navigate to="/" replace /> : <B2bLoginPage />} />
          <Route path="batches/new" element={me ? <NewBatchPage /> : <Navigate to="/login" replace />} />
          <Route path="batches/:batchNo/edit" element={me ? <NewBatchPage /> : <Navigate to="/login" replace />} />
          <Route path="batches/:batchNo" element={me ? <BatchPage /> : <Navigate to="/login" replace />} />
          <Route path="orders/:orderNo" element={me ? <OrderTimelinePage /> : <Navigate to="/login" replace />} />
          <Route path="shops/:id" element={me ? <ShopCatalogPage /> : <Navigate to="/login" replace />} />
          <Route path="shops/:id/items" element={me ? <ShopItemsPage /> : <Navigate to="/login" replace />} />
          <Route path="*" element={me ? <B2bHomePage /> : <Navigate to="/login" replace />} />
        </Routes>
      </main>
    </B2bContext.Provider>
  )
}
