import { deps, forward, requireIdempotencyKey } from '@/lib/deps'
import { route } from '@/lib/http'
import { requireSession } from '@/lib/session'

// 201：和 NestJS 版相同（POST 的預設狀態碼）
export const POST = route(async (ctx) => {
  const s = await requireSession(ctx.req.headers, deps().sessions)
  const key = requireIdempotencyKey(ctx.req)
  const data = await forward(s, ctx.correlationId, '/warehouse/withdrawals', { method: 'POST', body: await ctx.json(), headers: { 'idempotency-key': key } })
  return Response.json(data, { status: 201 })
})
