import { HttpError } from '@/lib/errors'
import { route } from '@/lib/http'

// /api 底下沒有對應的路徑：回 JSON 的 404（格式和 NestJS 版相同），不回 Next.js 的 HTML 404 頁
const notFound = route<{ path: string[] }>(async (ctx) => {
  throw new HttpError(404, { message: `Cannot ${ctx.req.method} ${new URL(ctx.req.url).pathname}`, error: 'Not Found', statusCode: 404 })
})

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE }
