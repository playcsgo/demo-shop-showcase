import { deps } from '@/lib/deps'
import { collectEvents } from '@/lib/events'
import { readCookie, route, SESSION_COOKIE } from '@/lib/http'
import { logger } from '@/lib/log'

export const POST = route(async (ctx) => {
  const body = await ctx.json<{ events?: Array<Record<string, any>> }>()
  const client = { sid: readCookie(ctx.req.headers, SESSION_COOKIE), userAgent: ctx.req.headers.get('user-agent') }
  return Response.json(await collectEvents(body, client, deps().sendEvents, logger), { status: 202 })
})
