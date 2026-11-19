'use client'

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { api, captureUtm, track } from './api.ts'
import { SiteFooter } from './components/SiteFooter.tsx'
import { SupportChat } from './components/SupportChat/SupportChat.tsx'
import { startReveal } from './reveal.ts'
import { Link, NavLink, usePathname } from './router.tsx'

type Me = { name: string; email: string } | null
export const MeContext = createContext<{ me: Me; setMe: (m: Me) => void }>({ me: null, setMe: () => {} })
export const useMe = () => useContext(MeContext)

/** 掛上去之後才畫：會讀 sessionStorage、網址參數的元件，伺服器端不畫（畫了也和瀏覽器的結果對不上） */
export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted ? children : null
}

/**
 * 每一頁共用的外框（對應 Vite 版的 App.tsx）：頂端列、頁尾、客服對話框、登入狀態。
 * 放在 layout：換頁時不會卸載，所以客服對話不斷線（AIC-018）。
 * 登入狀態在瀏覽器才問 /api/me：首頁的 HTML 對每個人都一樣，伺服器不用為了頂端列讀 session。
 */
export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>(null)
  const pathname = usePathname()

  useEffect(() => { captureUtm(); startReveal() }, [])
  useEffect(() => { api<Me>('/me').then(setMe).catch(() => setMe(null)) }, [])
  useEffect(() => { track('page_view') }, [pathname]) // 換頁也記一次

  return (
    <MeContext.Provider value={{ me, setMe }}>
      <header className="top" id="top">
        {/* 首頁的首屏就是大字標，頂端列不再放一次 */}
        {pathname !== '/' && <Link to="/" className="logo">Demo Shop</Link>}
        <nav>
          <NavLink to="/">商品</NavLink>
          <NavLink to="/cart">購物車</NavLink>
          {me ? <NavLink to="/me">會員中心（{me.name}）</NavLink> : <NavLink to="/login">登入</NavLink>}
        </nav>
      </header>
      <main className="page">{children}</main>
      <SiteFooter />
      <ClientOnly><SupportChat /></ClientOnly>
    </MeContext.Provider>
  )
}
