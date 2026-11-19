import { lookup } from 'node:dns/promises';

/**
 * 信任的代理（web 容器）的位址。容器的 IP 每次啟動都可能不同，所以用主機名稱查，
 * 快取 30 秒；查不到就當作沒有信任的代理（只用連線位址，不會被偽造的 header 騙）
 */
export function trustedProxies(env: NodeJS.ProcessEnv) {
  const host = env.SUPPORT_TRUSTED_PROXY_HOST;
  let cache: { at: number; addrs: Set<string> } | null = null;
  return async (): Promise<Set<string>> => {
    if (!host) return new Set();
    if (cache && Date.now() - cache.at < 30_000) return cache.addrs;
    const addrs = await lookup(host, { all: true }).then(
      (r) => new Set(r.map((a) => a.address)),
      () => new Set<string>(),
    );
    cache = { at: Date.now(), addrs };
    return addrs;
  };
}
