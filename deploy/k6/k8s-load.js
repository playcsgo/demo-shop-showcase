// K8s 壓力測試：k6 跑在叢集裡（scripts/k8s.sh load），直接打 core 的 Service
// 沿用 sandbox 的購物流程（shop.js），每秒下單數依 STAGES 逐步變化，例如 10:1m,40:2m,80:2m,0:1m
// 看點：core-api（HPA 看 CPU）、hub 各廠商（KEDA 看佇列長度）自動多開 Pod，壓力停止後縮回來，帳仍然正確
import { catalog, login, shop } from './shop.js';

const stages = (__ENV.STAGES || '10:1m,40:2m,80:2m,0:1m').split(',').map((s) => {
  const [target, duration] = s.split(':');
  return { target: Number(target), duration };
});

export const options = {
  scenarios: {
    load: { executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s', preAllocatedVUs: 100, maxVUs: 400, stages },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export const setup = () => catalog();

export default function (skus) {
  login();
  shop(skus, { doubleClickRate: 0 });
}
