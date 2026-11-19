import { unwrap } from '@/lib/core-client'
import { deps } from '@/lib/deps'
import { route, sessionCookie } from '@/lib/http'

/** 登入：core 驗密碼並簽 JWT → BFF 用 JWKS 驗章 → 存進 session → 瀏覽器只拿到 httpOnly cookie */
export const POST = route(async (ctx) => {
  const { core, sessions, verifyJwt, secureCookie } = deps()
  const data = unwrap(await core.call<any>('/auth/login', { method: 'POST', body: await ctx.json(), correlationId: ctx.correlationId }))
  const claims = await verifyJwt(data.access_token)

  const session = await sessions.create({
    customerId: Number(claims.sub), name: data.customer.name, email: data.customer.email,
    token: data.access_token, tokenExp: claims.exp!,
  })

  // 回應裡沒有任何 token
  return Response.json({ name: session.name, email: session.email }, { headers: { 'set-cookie': sessionCookie(session.sid, secureCookie) } })
})
