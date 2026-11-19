// sandbox 容器的 CPU → Prometheus（scripts/k8s.sh metrics 開的 demo-docker-cpu）
// 不用 cAdvisor：它在 OrbStack 上認不出 Docker 容器（failed to identify the read-write layer），只有整台機器的數字
// 直接問 Docker API，標籤和 K8s 的一樣（env、app_service），看板用同一條查詢
import { createServer, request } from 'node:http';

const docker = (path) => new Promise((resolve, reject) => {
  request({ socketPath: '/var/run/docker.sock', path }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject).end();
});

async function metrics() {
  const filters = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project'] }));
  const all = await docker(`/containers/json?filters=${filters}`);
  const sets = all.filter((c) => /^demo-sb\d+$/.test(c.Labels['com.docker.compose.project']));
  const lines = await Promise.all(sets.map(async (c) => {
    const stats = await docker(`/containers/${c.Id}/stats?stream=false&one-shot=true`);
    const env = c.Labels['com.docker.compose.project'].replace('demo-sb', 'sandbox-');
    const seconds = stats.cpu_stats.cpu_usage.total_usage / 1e9;
    return `container_cpu_usage_seconds_total{env="${env}",app_service="${c.Labels['com.docker.compose.service']}"} ${seconds}`;
  }));
  return `# TYPE container_cpu_usage_seconds_total counter\n${lines.join('\n')}\n`;
}

createServer((_, res) => {
  res.setHeader('content-type', 'text/plain; version=0.0.4');   // 沒帶的話 Prometheus 不收
  metrics().then((text) => res.end(text)).catch((e) => { res.statusCode = 500; res.end(String(e)); });
}).listen(9101);
