# 壓測報告 Load test reports

dev-container（舊名 sandbox）和 K8s（自動擴充／預先開滿）共用同一份報告格式。\
dev-container (formerly sandbox) and K8s (autoscaling or pre-scaled) share one report format.

每一輪壓測產出一份 `run.json`，報告由它產生。\
Each load run writes a `run.json`, and the report is generated from it.

## 怎麼跑 How to run

```bash
node loadtest/run.mjs                                                     # 基準：K8s 自動擴充、1 桶、兩個世界 / baseline: K8s autoscaling, 1 bucket, both worlds
node loadtest/run.mjs --change "庫存 1 桶 → 8 桶" --buckets 8 --baseline ../tests/<基準的資料夾>
# 微服務處理速度：完美世界、只買直送、不打查詢（--mode 換成要比的模式）
# Per-service speed: perfect world, direct delivery only, no queries (set --mode to the mode to compare)
node loadtest/run.mjs --mode dev-container --worlds perfect --direct-only --ratio 0 --levels 5,10,20 --change "dev-container"
```

| `--mode` | 環境<br>Environment | Pod／容器數<br>Pods / containers |
|---|---|---|
| `dev-container` | docker compose 第 1 套；開跑前重新 build、部署（`scripts/sandbox.sh up 1`）<br>Compose set 1, rebuilt and redeployed before the run (`scripts/sandbox.sh up 1`) | 每個服務 1 個容器<br>One container per service |
| `k8s-single` | K8s（kind） | 可以擴充的服務全部固定 1 個 Pod<br>Every scalable service fixed at 1 pod |
| `k8s-auto`（預設 default） | K8s | HPA＋KEDA 自己擴，從最少的 Pod 數開始<br>HPA + KEDA scale on their own, starting from the minimum |
| `k8s-max` | K8s | 開跑前直接開到 HPA／KEDA 的上限<br>Scaled to the HPA / KEDA maximum before the run |
| `k8s-fixed4` | K8s | 可以擴充的服務全部固定 4 個 Pod<br>Every scalable service fixed at 4 pods |
| `k8s-go-best` | K8s | Go 版調校：core-api 固定 4 個、`DB_MAX_OPEN=20`，relay 8 個，其他開到上限<br>Go tuning: core-api fixed at 4 with `DB_MAX_OPEN=20`, relay at 8, everything else at maximum |

- 可以擴充的服務：core-api、bff、core-worker、core-relay、hub-api、hub 的六種 worker。\
  Scalable services: core-api, bff, core-worker, core-relay, hub-api and the six hub workers.\
  core-scheduler（排程只能一個）、partners（模擬廠商，狀態在記憶體）、MySQL、Redis 不動。\
  core-scheduler (only one scheduler may run), partners (mock vendors with in-memory state), MySQL and Redis stay as they are.
- 跑完會把 HPA、KEDA、Deployment 的設定還原。\
  HPA, KEDA and Deployment settings are restored after the run.
- Datadog 要只送指標、不開 APM，因為 trace 很吃 CPU。\
  Datadog should send metrics only, without APM, because tracing is CPU-heavy.\
  dev-container 用 `scripts/sandbox.sh datadog 1 all --no-apm`；K8s 在 `.env` 設 `DATA_DOG_APM=FALSE` 再跑 `scripts/bootstrap.sh`。\
  For dev-container use `scripts/sandbox.sh datadog 1 all --no-apm`; for K8s set `DATA_DOG_APM=FALSE` in `.env` and run `scripts/bootstrap.sh`.\
  APM 開著時 run.log 會警告，報告也會記下來（`meta.datadog`）。\
  If APM is on, run.log warns and the report records it (`meta.datadog`).
- 結果預設放在 repo 旁邊的 `../tests/<時間>-<英數字>/`，報告不進 repo，`--out` 可以換地方。\
  Results go next to the repo in `../tests/<time>-<id>/` by default, outside the repo; `--out` changes the location.\
  內容有 `report.html`（有圖表）、`report.md`、`run.json`，以及原始資料（`samples-*.json` 每 5 秒的取樣、`k6-*.json`、`run.log`）。\
  It holds `report.html` (with charts), `report.md`, `run.json` and the raw data (`samples-*.json` sampled every 5 seconds, `k6-*.json`, `run.log`).
- 一輪約 25 分鐘：每個世界重建 1 分鐘、低流量 3 分鐘、五階約 5 分鐘，再等消化完。\
  A run takes about 25 minutes: per world, 1 minute to rebuild, 3 minutes at low traffic, about 5 minutes for five steps, then waiting for the backlog to drain.
- **會重建 K8s 的資料庫**，跑的時候要獨佔這台電腦。\
  **It rebuilds the K8s database**, and the machine should be reserved for the run.
- 只想重新產生報告（例如換比較對象）：\
  To regenerate a report only (for example against a different baseline):

```bash
node loadtest/report/cli.mjs <run.json> [--baseline <基準的 run.json>]   # 寫在 run.json 旁邊的 report.md、report.html / writes report.md and report.html next to run.json
node loadtest/report/cli.mjs --sample                                    # 假資料的範例報告 / sample report from fake data → sample-report.md, sample-report.html
```

| 檔案<br>File | 做什麼<br>What it does |
|---|---|
| `../run.mjs` | 主程式：每個世界重建環境 → 套用廠商設定 → 取樣＋k6 → 等消化完 → 不變式 → Loki 算 pay_e2e<br>Main script: per world, rebuild → apply vendor settings → sample + k6 → drain → invariants → pay_e2e from Loki |
| `../collect/k8s.mjs` | K8s 轉接層：重建、預先開滿／還原、每 5 秒取樣、跑 k6 Job、Loki 的 port-forward<br>K8s adapter: rebuild, pre-scale and restore, sample every 5 seconds, run the k6 Job, port-forward to Loki |
| `../collect/aggregate.mjs` | 把取樣切成每一階的窗口和時間序列；用 Loki 的 log 配對出 pay_e2e<br>Cuts samples into per-step windows and time series; pairs Loki logs into pay_e2e |
| `../../deploy/k6/levels.js` | k6：低流量基準＋每一階一個 scenario，查詢和下單同時打<br>k6: a low-traffic baseline plus one scenario per step, with queries and orders sent together |
| `predict.mjs` | 推測值：query、pay_api 用先前實測當先驗；pay_e2e 用這一輪實際套用的廠商設定模擬分布<br>Predictions: query and pay_api use earlier measurements as priors; pay_e2e simulates the distribution from the vendor settings actually applied |
| `render.mjs` | 產生 Markdown 報告，判斷「哪一階開始變慢」「誰飽和」<br>Builds the Markdown report and decides which step slowed down and what saturated |
| `html.mjs` | HTML 版：同樣的內容加上圖表，單一檔案、不連外網<br>HTML version: the same content plus charts, in a single file with no external requests |
| `sample.mjs` | 範例資料（假的）<br>Sample data (fake) |

## 每一輪的規則 Rules for every run

- 兩個世界都跑：`perfect`（完美世界）、`realistic`（真實世界）。\
  Both worlds run: `perfect` and `realistic`.
- 查詢和下單兩條流量**同時**打，查詢固定是下單的 20 倍（`meta.queryRatio`）。\
  Query and order traffic run **at the same time**, with queries fixed at 20× orders (`meta.queryRatio`).
- 每一階先爬升再維持，只統計維持那段：量的是「每秒 X 筆能不能一直撐住」。\
  Each step ramps up and then holds, and only the hold counts: it measures whether X per second can be sustained.
- 低流量基準：每秒下單 1 筆＋查詢 20 次，維持 3 分鐘，約 150 筆訂單，p99 才有意義。\
  Low-traffic baseline: 1 order and 20 queries per second for 3 minutes, about 150 orders, so p99 means something.
- 每個世界開跑前重建資料庫，seed 固定。\
  The database is rebuilt before each world, with a fixed seed.
- 一次只改一個條件，寫在 `meta.change`。\
  Change one condition at a time and record it in `meta.change`.\
  跟基準比時，報告會列出兩輪所有條件的差異，不只一個就會警告。\
  When comparing with a baseline, the report lists every difference between the two runs and warns if there is more than one.
- 不變式沒過，這一輪的效能數字不算數。\
  If the invariants fail, the run's performance numbers do not count.

## 測試情境 Test scenarios

| 情境<br>Scenario | 量什麼<br>What it measures | 什麼時候跑<br>When it runs |
|---|---|---|
| 爬升（這份報告）<br>Ramp (this report) | 穩定容量：每秒幾筆撐得住、瓶頸是誰<br>Steady capacity: how many per second it sustains and what the bottleneck is | 本機手動，每次改效能相關的程式之後<br>Manually on a local machine, after any performance-related change |
| 湧入（之後做）<br>Surge (planned) | 突然爆量：0 → 100 筆／秒瞬間湧入，看自動擴充跟不跟得上、擴充前失敗多少<br>A sudden spike from 0 to 100 per second: does autoscaling keep up, and how much fails before it does | 非正常測試，本機手動，**不進 CI**<br>An abnormal test, run manually and **not in CI** |

## run.json 格式 The run.json format

`dist` ＝ `{ n, p50, p95, p99 }`（毫秒；n 是樣本數）\
`dist` = `{ n, p50, p95, p99 }` (milliseconds; n is the sample count)

```jsonc
{
  "schema": 1,
  "meta": {
    "id": "20261014-1530-buckets8",           // 也是存檔資料夾的名字 / also the name of the output folder
    "startedAt": "2026-10-14 15:30",
    "commit": "3d97ddb",
    "seed": 42,
    "mode": "k8s-auto",                       // dev-container | k8s-single | k8s-auto | k8s-max | k8s-fixed4
    "directOnly": false,                      // --direct-only
    "datadog": { "metrics": true, "apm": false, "env": "k8s" },
    "change": "庫存 1 桶 → 8 桶",              // 基準填 null / null for a baseline
    "catalog": "搶購：11 個商品",
    "buckets": 8,
    "dbReset": true,
    "idle": { "order": 1, "query": 20, "holdSec": 180 },              // 低流量基準 / low-traffic baseline
    "queryRatio": 20,                                                  // 查詢＝下單 × 20，同時打 / queries = orders × 20, sent together
    "levels": { "query": [400, 800, 1200], "order": [20, 40, 60] },   // 各階每秒數 / per-second rate for each step
    "rampSec": 15, "holdSec": 40,
    "env": { "節點": "1 控制＋3 工作", "電腦": "Mac mini 10 核" }
  },
  "worlds": {
    "perfect": {
      "partnerSettings": { "payment": { "latencyMs": 0, "latencyJitterMs": 0, "errorRate": 0, "callbackDelayMs": 500 }, "logistics": {}, "clinic": {} },
      "idle": { "query": dist, "pay_api": dist, "pay_e2e": dist },
      "levels": [{
        "target":   { "query": 200, "order": 20 },
        "achieved": { "query": 200, "order": 20 },     // 維持那段實際每秒 / actual per second during the hold
        "dropped": 0,                                   // k6 開不出虛擬客人 / virtual users k6 could not start
        "success": { "query": 1, "order": 0.9995 },
        "query": dist, "pay_api": dist, "pay_e2e": dist,
        "e2eUnfinished": 0,                             // 統計結束時還沒付款完成的訂單數 / orders not yet paid when measurement ended
        "sat": {                                        // 維持那段的最大值 / maximum during the hold
          "services": { "core-api": { "pods": 2, "maxPods": 8, "cpuM": 190, "cpuCapM": null, "memMi": 210, "memLimitMi": 512 } },
          "fpm":  { "busy": 5, "max": 20, "queue": 0 },
          "db":   { "conns": 12, "maxConns": 151, "lockWaits": 0 },
          "sqs":  { "payment-commands": { "backlog": 2, "growthPerSec": 0 } },
          "host": { "cpuUsed": 2.3, "cpus": 10 }
        }
      }],
      "correctness": { "invariants": [{ "name": "庫存不超賣", "pass": true, "detail": "" }] },
      "timeseries": [{ "t": 0, "services": { "core-api": { "pods": 2, "cpuM": 190, "cpuCapM": null } } }]   // 每 5 秒一筆 / one entry every 5 seconds
    },
    "realistic": { /* 同上 / same as above */ }
  }
}
```

## 指標從哪裡來 Where the metrics come from

| 欄位<br>Field | 來源<br>Source |
|---|---|
| `query`、`pay_api` | k6 每筆請求的原始資料（`--out csv`），依 action 和購物種類分組；`pay_api` 只算直送／寄倉<br>Raw k6 per-request data (`--out csv`), grouped by action and purchase type; `pay_api` counts direct and stored-stock orders only |
| `pay_e2e` | Loki：同一個 correlation_id 的 `order placed` 到 `payment succeeded → order PAID` 兩行 log 的時間差；只算直送／寄倉<br>Loki: the time between the `order placed` and `payment succeeded → order PAID` lines for the same correlation_id; direct and stored-stock orders only |
| `partnerSettings` | 開跑前 `GET partners /admin/state`，是實際套用的值，不是 preset 的名字<br>`GET partners /admin/state` before the run: the values actually applied, not the preset name |
| `sat.services` | dev-container：`docker stats`；K8s：`kubectl top pods`＋各 Deployment 的副本數與 limit，每 5 秒取樣<br>dev-container: `docker stats`; K8s: `kubectl top pods` plus each Deployment's replicas and limits, sampled every 5 seconds |
| `sat.fpm` | 每個 core-api 的 `/fpm-status?json`，加總<br>Each core-api's `/fpm-status?json`, summed |
| `sat.db` | MySQL：`Threads_connected`、`max_connections`、`information_schema.innodb_trx` 裡在等鎖的交易數<br>MySQL: `Threads_connected`, `max_connections` and the transactions waiting on locks in `information_schema.innodb_trx` |
| `sat.sqs` | 各佇列 `ApproximateNumberOfMessages`＋`NotVisible`；`growthPerSec` ＝ 維持那段頭尾積壓的差 ÷ 秒數<br>Each queue's `ApproximateNumberOfMessages` + `NotVisible`; `growthPerSec` = backlog change over the hold ÷ seconds |
| `sat.host` | dev-container：整台電腦；K8s：所有節點加總<br>dev-container: the whole machine; K8s: all nodes summed |
| `correctness` | 跑完、SQS 消化完之後 `php artisan reconcile:check --json`<br>`php artisan reconcile:check --json` after the run, once SQS has drained |
| `timeseries` | 跟 `sat.services` 同一個取樣迴圈，每 5 秒存一筆<br>The same sampling loop as `sat.services`, one entry every 5 seconds |

## 判斷規則 Judgement rules

- **開始變慢**（任一項）：查詢或結帳 API 的 p95 超過低流量的 3 倍、成功率 < 99%、實際送出 < 目標 95%、有客人進不來。\
  **Slowing down** (any of): query or checkout API p95 above 3× the low-traffic value, success below 99%, sent below 95% of target, or virtual users unable to start.
- **飽和**：CPU／記憶體 ≥ 80% 上限、FPM ≥ 90% 忙、等鎖 ≥ 10 個交易、DB 連線 ≥ 90%、SQS 積壓每秒增加 ≥ 1 則、整台電腦 CPU ≥ 90%，或（自動擴充模式）Pod 擴到上限。\
  **Saturated:** CPU or memory ≥ 80% of the limit, FPM ≥ 90% busy, ≥ 10 transactions waiting on locks, DB connections ≥ 90%, an SQS backlog growing ≥ 1 per second, host CPU ≥ 90%, or (in autoscaling mode) pods at their maximum.
- **CPU 上限**（`cpuCapM`）：刻意沒設 CPU limit，避免被節流。\
  **CPU cap** (`cpuCapM`): no CPU limit is set on purpose, to avoid throttling.\
  一個 Pod 只跑一支單執行緒程式的服務（hub、bff、partners、LocalStack、Redis、core-worker／relay／scheduler）上限算 1 核。\
  Services that run one single-threaded program per pod (hub, bff, partners, LocalStack, Redis, core-worker / relay / scheduler) count as capped at 1 core.\
  core-api（PHP-FPM）、MySQL、ProxySQL 是 `null`，不算百分比，改看 FPM 忙碌數和整台電腦。\
  core-api (PHP-FPM), MySQL and ProxySQL are `null`: no percentage, so look at busy FPM workers and the whole machine instead.
- **在等，不是在算**：Pod 擴到上限、CPU 卻 < 50% 上限；或 FPM 全忙、平均每個忙碌的 worker 用不到 0.3 顆核心，就提示「多開 Pod 沒用」。\
  **Waiting, not working:** pods at maximum but CPU below 50% of the cap, or FPM fully busy with each busy worker using under 0.3 cores on average, triggers a "more pods will not help" hint.\
  整台電腦 CPU 滿的時候不算，那是核心不夠分。\
  This does not apply when host CPU is full, since then there are simply not enough cores.
- 飽和時間線照「最早飽和」排序，只是提示；同一階一起飽和的，要人判斷誰造成誰。\
  The saturation timeline is sorted by what saturated first and is only a hint; when several saturate in the same step, a person has to judge which caused which.
