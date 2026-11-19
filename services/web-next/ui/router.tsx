'use client'

// 頁面元件是從 Vite 版搬過來的，原本用 react-router-dom。這裡用 Next.js 的路由做出同樣的介面，
// 頁面只要改 import 的來源，內容不用動，兩個版本的頁面容易對照
import NextLink from 'next/link'
import { useParams as useNextParams, usePathname, useRouter } from 'next/navigation'
import { type ComponentProps, useEffect, useState } from 'react'

export { usePathname }

type To = string | { pathname: string; hash?: string }
const hrefOf = (to: To) => (typeof to === 'string' ? to : to.pathname + (to.hash ?? ''))
type AnchorProps = Omit<ComponentProps<'a'>, 'href'>

export function Link({ to, ...rest }: AnchorProps & { to: To }) {
  return <NextLink href={hrefOf(to)} {...rest} />
}

/** 目前所在的頁面會加上 active（和 react-router 相同）；「/」只在首頁才算，end 表示要完全相同 */
export function NavLink({ to, end, className, ...rest }: AnchorProps & { to: string; end?: boolean }) {
  const path = usePathname()
  const active = end || to === '/' ? path === to : path === to || path.startsWith(`${to}/`)
  return <NextLink href={to} className={[className, active ? 'active' : ''].filter(Boolean).join(' ') || undefined} aria-current={active ? 'page' : undefined} {...rest} />
}

export function useNavigate() {
  const router = useRouter()
  return (to: string) => router.push(to)
}

export const useParams = () => useNextParams() as Record<string, string | undefined>

/** 只給「在瀏覽器才畫」的頁面用（登入頁）：直接讀網址，不用 Next.js 的 useSearchParams（那個要包 Suspense） */
export function useSearchParams(): [URLSearchParams] {
  return [new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)]
}

/** search 和 hash 伺服器看不到，掛上去之後才從網址讀 */
export function useLocation() {
  const pathname = usePathname()
  const [rest, setRest] = useState({ search: '', hash: '' })
  useEffect(() => {
    const read = () => setRest({ search: window.location.search, hash: window.location.hash })
    read()
    addEventListener('hashchange', read)
    return () => removeEventListener('hashchange', read)
  }, [pathname])
  return { pathname, ...rest }
}
