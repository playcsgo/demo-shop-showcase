import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Shell } from '@/ui/shell.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: 'Demo Shop',
  description: 'Demo Shop：狗和貓的吃的、用的（demo 用的虛構商店）',
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>{/* reveal.ts 會在 <html> 加上 js 這個 class */}
      <head>
        <link rel="preload" href="/fonts/besley-800-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/libre-franklin-latin.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
