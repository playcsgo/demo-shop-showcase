import { deps } from '@/lib/deps'
import { route } from '@/lib/http'
import { buildOverview } from '@/lib/overview'
import { requireSession } from '@/lib/session'

export const GET = route(async (ctx) => {
  const { core, sessions } = deps()
  const s = await requireSession(ctx.req.headers, sessions)
  const token = await sessions.freshToken(s, ctx.correlationId)
  return Response.json(await buildOverview(core, { token, correlationId: ctx.correlationId, name: s.name }))
})
