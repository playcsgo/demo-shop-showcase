import type { CSSProperties } from 'react'

// 四個品牌就是四層貨架（AIC-012：狗吃的、狗用的、貓吃的、貓用的）。
// 首屏、狗／貓兩塊、頁尾的連結都從這裡來；顏色在 index.css 的 --field-<品牌代號>
export const SHELVES = [
  { code: 'SB', id: 'dog-food', title: '狗吃的', pet: 'dog' },
  { code: 'AK', id: 'dog-goods', title: '狗用的', pet: 'dog' },
  { code: 'BC', id: 'cat-food', title: '貓吃的', pet: 'cat' },
  { code: 'MT', id: 'cat-goods', title: '貓用的', pet: 'cat' },
] as const

/** 品牌的色塊；不認得的品牌用預設的面色 */
export const field = (code: string) => ({ '--field': `var(--field-${code}, var(--surface))` }) as CSSProperties

/** 進場動畫的順序（reveal.ts）：同一段裡第幾個上來 */
export const delay = (step: number) => ({ '--i': step }) as CSSProperties
