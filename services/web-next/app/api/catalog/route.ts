import { loadCatalog } from '@/lib/catalog'
import { route } from '@/lib/http'

export const GET = route(async (ctx) => Response.json(await loadCatalog(ctx.correlationId)))
