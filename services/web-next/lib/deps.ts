import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs'
import { Redis } from 'ioredis'
import { CoreClient, unwrap, type CallOptions } from './core-client'
import type { SendBatch } from './events'
import { HttpError } from './errors'
import { createJwtVerifier } from './jwks'
import { SessionStore, type Session } from './session'

/**
 * 整個程序共用一份的東西（Redis 連線、core 入口、session、SQS）。
 * 第一次用到才建立：next build 會載入 route 檔，那時候不能去連 Redis。
 * 放在 globalThis：next dev 熱重載時不會每次多開一條 Redis 連線。
 */
function build() {
  const env = process.env
  const coreUrl = env.CORE_URL ?? 'http://core-nginx'
  const redis = new Redis(env.REDIS_URL ?? 'redis://redis:6379/3')
  const core = new CoreClient({ base: coreUrl })
  const sessions = new SessionStore(redis, core, env.BFF_SERVICE_KEY ?? '')

  let sqs: SQSClient | undefined
  const sendEvents: SendBatch = async (entries) => {
    if (!env.SQS_PREFIX) throw new Error('SQS_PREFIX is not set')
    sqs ??= new SQSClient({
      region: env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
      ...(env.AWS_ENDPOINT ? { endpoint: env.AWS_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    })
    await sqs.send(new SendMessageBatchCommand({ QueueUrl: `${env.SQS_PREFIX}/analytics-events`, Entries: entries }))
  }

  return {
    redis, core, sessions, sendEvents,
    verifyJwt: createJwtVerifier(coreUrl),
    secureCookie: env.COOKIE_SECURE === '1',
    supportServiceKey: env.SUPPORT_SERVICE_KEY ?? '',
  }
}

type Deps = ReturnType<typeof build>
const holder = globalThis as unknown as { __webNextDeps?: Deps }
export const deps = (): Deps => (holder.__webNextDeps ??= build())

/** 帶上伺服器端的 JWT 轉給 core，結果原樣回來（錯誤也是）。前台只認 BFF，不知道 core 在哪、也拿不到 token */
export async function forward(s: Session, correlationId: string, path: string, opts: Pick<CallOptions, 'method' | 'body' | 'headers'> = {}) {
  const { core, sessions } = deps()
  return unwrap(await core.call(path, { ...opts, token: await sessions.freshToken(s, correlationId), correlationId }))
}

export function requireIdempotencyKey(req: Request): string {
  const key = req.headers.get('idempotency-key')
  if (!key) throw new HttpError(400, { error: 'idempotency_key_required' })
  return key
}
