#!/usr/bin/env node
// K8s 的 Pod 數模式（sandbox UI 的按鈕也呼叫這一支）：切換後一直維持，直到切成別的模式
//
//   node loadtest/k8s-mode.mjs              目前是哪個模式
//   node loadtest/k8s-mode.mjs k8s-fixed4   切換：k8s-single｜k8s-auto｜k8s-max｜k8s-fixed4｜k8s-go-best（只限 Go）
import { currentMode, MODES, setMode, sleep, waitReady } from './collect/k8s.mjs';

const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${m}`);
const mode = process.argv[2];
if (!mode) {
  const m = await currentMode();
  console.log(`${m}：${MODES[m] ?? ''}`);
  process.exit(0);
}
await setMode(mode, log);
log('等 HPA／KEDA 調整 Pod 數…');
await sleep(20_000);
await waitReady(log);
log(`完成：${await currentMode()}`);
