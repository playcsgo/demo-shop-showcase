import { createContext, useContext, useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api, track } from './api.ts'
import { CatalogPage } from './pages/CatalogPage.tsx'
import { CartPage } from './pages/CartPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { OrderPage } from './pages/OrderPage.tsx'
import { MemberPage } from './pages/MemberPage.tsx'
import { SupportChat } from './components/SupportChat/SupportChat.tsx'
import { SiteFooter } from './components/SiteFooter.tsx'

type Me = { name: string; email: string } | null
export const MeContext = createContext<{ me: Me; setMe: (m: Me) => void }>({ me: null, setMe: () => {} })
export const useMe = () => useContext(MeContext)

export default function App() {
  const [me, setMe] = useState<Me>(null)
  const location = useLocation()

  useEffect(() => { api<Me>('/me').then(setMe).catch(() => setMe(null)) }, [])
  useEffect(() => { track('page_view') }, [location.pathname]) // SPA 換頁也記一次

  return (
    <MeContext.Provider value={{ me, setMe }}>
      <header className="top" id="top">
        {/* 首頁的首屏就是大字標，頂端列不再放一次 */}
        {location.pathname !== '/' && <Link to="/" className="logo">Demo Shop</Link>}
        <nav>
          <NavLink to="/">商品</NavLink>
          <NavLink to="/cart">購物車</NavLink>
          {me ? <NavLink to="/me">會員中心（{me.name}）</NavLink> : <NavLink to="/login">登入</NavLink>}
        </nav>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<CatalogPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/orders/:orderNo" element={<OrderPage />} />
          <Route path="/me/*" element={<MemberPage />} />
        </Routes>
      </main>
      <SiteFooter />
      <SupportChat />   {/* 放在最外層：換頁不會卸載、不斷線（AIC-018） */}
    </MeContext.Provider>
  )
}
