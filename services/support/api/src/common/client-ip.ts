/**
 * 請求都經過 web 容器的 Vite 代理，連線位址永遠是代理。只有連線真的來自信任的代理時，
 * 才用 X-Forwarded-For 最後一個位址（代理自己加上的）；其他人帶這個 header 一律忽略
 */
export function clientIp(
  remote: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: Set<string>,
): string {
  const peer = (remote ?? '').replace(/^::ffff:/, '');
  if (!forwardedFor || !trustedProxies.has(peer)) return peer;
  const hops = forwardedFor
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return (hops[hops.length - 1] ?? peer).replace(/^::ffff:/, '');
}
