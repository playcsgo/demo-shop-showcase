import { deps } from '@/lib/deps'
import { route } from '@/lib/http'
import { requireSession } from '@/lib/session'

export const GET = route(async (ctx) => {
  const s = await requireSession(ctx.req.headers, deps().sessions)
  return Response.json({ name: s.name, email: s.email })
})
