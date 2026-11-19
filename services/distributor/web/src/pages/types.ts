export type Tier = { min_cases: number; unit_price_minor: number }
export type CatalogItem = {
  product_id: number; sku: string; name: string; temperature_class: string
  moq_cases: number; case_size: number; case_multiple: number; tiers: Tier[]
}
export type Shop = { id: number; name: string; country_code: string; city: string; address: string; destination_port: string | null }

/** 最小單位 → 顯示金額：JPY、TWD 沒有小數，其他兩位。和後端的 Money 同一份規則 */
export function formatMoney(minor: number, currency: string) {
  const digits = ['TWD', 'JPY'].includes(currency) ? 0 : 2
  return `${currency} ${(minor / 10 ** digits).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export type BatchWarning = {
  shop_name: string; sku: string; country: string; banned: boolean
  banned_ingredients: Array<{ name: string; reason: string | null }>; missing_ingredients: boolean; missing_hs_code: boolean
}

export function warningTexts(w: BatchWarning): string[] {
  return [
    ...w.banned_ingredients.map((b) => `含${b.name}，這個國家禁止${b.reason ? `：${b.reason}` : ''}`),
    w.missing_ingredients ? '未填成分，無法檢查' : '',
    w.missing_hs_code ? '缺 HS code' : '',
  ].filter(Boolean)
}
export type MoqResult = { sku: string; total_cases: number; moq_cases: number; met: boolean }
export type PricedOrder = {
  shop_id: number; shop_name: string; requested_ship_date: string | null; subtotal_minor: number
  items: Array<{ product_id: number; sku: string; qty_cases: number; case_size: number; qty_units: number; unit_price_minor: number; amount_minor: number; hs_code: string | null }>
}
export type Priced = {
  order_type: 'stock' | 'early_bird'; currency: string; total_minor: number; prepay_bps: number; prepay_minor: number
  orders: PricedOrder[]; warnings: BatchWarning[]; moq_results: MoqResult[]; stock_shortages?: string[]
}
export type Batch = Priced & {
  batch_no: string; status: string; reject_reason: string | null; revision: number; submitted_at: string; anticipated_response_date: string
  orders: Array<PricedOrder & { order_no: string; status: string; eta_date: string | null }>
}

export const BATCH_STATUS: Record<string, string> = {
  IN_REVIEW: '審核中', REJECTED: '已退回', AWAITING_PAYMENT: '審核通過，等待付款', AWAITING_START: '審核通過，準備中', COMPLETED: '已完成', CANCELLED: '已取消',
}
export const ORDER_STATUS: Record<string, string> = { PENDING: '未開始', SHIPPED: '已出貨', DELIVERED: '已送達' }
// 同一個狀態，現貨和早鳥對經銷商的意思不同
export const batchStatusLabel = (status: string, type: string) =>
  status === 'PROCESSING' ? (type === 'stock' ? '處理中' : '排產中') : BATCH_STATUS[status] ?? status
export const orderStatusLabel = (status: string, type: string) =>
  status === 'IN_PROGRESS' ? (type === 'stock' ? '待出貨' : '排產中') : ORDER_STATUS[status] ?? status
export const ORDER_TYPE: Record<string, string> = { stock: '現貨', early_bird: '早鳥' }

export type Revision = { revision: number; submitted_at: string; reject_reason: string | null; rejected_at: string | null; total_minor: number; order_type: string }
