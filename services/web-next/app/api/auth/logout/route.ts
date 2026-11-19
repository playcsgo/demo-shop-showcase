import { deps } from '@/lib/deps'
import { clearSessionCookie, readCookie, route, SESSION_COOKIE } from '@/lib/http'

export const POST = route(async (ctx) => {
  const sid = readCookie(ctx.req.headers, SESSION_COOKIE)
  if (sid) await deps().sessions.destroy(sid)
  return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie() } })
})
