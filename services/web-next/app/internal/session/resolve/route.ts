import { deps } from '@/lib/deps'
import { route } from '@/lib/http'
import { resolveSession } from '@/lib/session-resolve'

// 不在 /api 底下，和 NestJS 版同一個路徑：support 用 BFF_URL 直接打服務，不經過對外的入口
export const POST = route(async (ctx) => {
  const { sessions, supportServiceKey } = deps()
  const result = await resolveSession({ expectedKey: supportServiceKey, providedKey: ctx.req.headers.get('x-service-key'), body: await ctx.json(), sessions })
  return Response.json(result)
})
