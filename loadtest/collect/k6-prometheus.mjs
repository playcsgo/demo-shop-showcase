// k6 的計數也送進 Prometheus（scripts/k8s.sh metrics 裝的），Grafana 才看得到送出、被擋了多少筆
// 沒裝監控就略過：壓測照跑，數字只在報告裡
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SERVICE = 'metrics-kube-prometheus-st-prometheus';
export const K8S_URL = `http://${SERVICE}.monitoring.svc.cluster.local:9090/api/v1/write`;
export const NODE_PORT = 30090;

const installed = () => promisify(execFile)('kubectl', ['--context', 'kind-demo-shop', '-n', 'monitoring', 'get', 'service', SERVICE], { timeout: 15_000 })
  .then(() => true, () => false);

/** k6 要多帶的參數和環境變數。env 和指標的 env 同名，run 分開每一輪：計數每輪從 0 開始，看板取每輪的最終值加總 */
export async function k6Output({ url, env }) {
  if (!url || !(await installed())) return { args: [], env: {} };
  return {
    args: ['-o', 'experimental-prometheus-rw', '--tag', `env=${env}`, '--tag', `run=${Date.now()}`],
    env: {
      K6_PROMETHEUS_RW_SERVER_URL: url,
      K6_PROMETHEUS_RW_PUSH_INTERVAL: '5s',
      // 不留 url、name：購物車之類的網址每次不同，留著會多出大量 series
      K6_SYSTEM_TAGS: 'status,method,scenario',
    },
  };
}
