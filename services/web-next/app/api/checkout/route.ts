import { unwrap } from '@/lib/core-client'
import { deps, requireIdempotencyKey } from '@/lib/deps'
import { route } from '@/lib/http'
import { requireSession } from '@/lib/session'

/** 結帳：Idempotency-Key 由前台產生（每次按「結帳」前產生一次），BFF 原樣轉給 core；狀態碼照 core 回的（新訂單 201、重送 200） */
export const POST = route(async (ctx) => {
  const { core, sessions } = deps()
  const s = await requireSession(ctx.req.headers, sessions)
  const key = requireIdempotencyKey(ctx.req)
  const r = await core.call('/checkout', {
    method: 'POST', body: await ctx.json(), token: await sessions.freshToken(s, ctx.correlationId), correlationId: ctx.correlationId, headers: { 'idempotency-key': key },
  })
  return Response.json(unwrap(r), { status: r.status })
})
