# Demo Shop

一套多服務的電商後端，涵蓋下單、付款、出貨到退款。\
A multi-service e-commerce backend covering checkout, payment, shipping and refunds.

下單只寫資料庫就回應，和金流、物流的往來全部走佇列。\
Checkout only writes to the database before responding, and every exchange with payment and logistics vendors goes through queues.

用 Outbox／Inbox＋ACID 交易確保「收了錢就一定有訂單」。\
Outbox / inbox and ACID transactions make sure a charge always has an order.

用故障注入的 sandbox 驗證帳務，在 Kubernetes 上逐階加壓找瓶頸。\
A fault-injecting sandbox checks the books, and stepped load tests on Kubernetes find the bottleneck.

這個 repo 是整理過的展示版本，原本的開發歷史不在這裡。\
This repo is a curated showcase; the original development history is not included.

程式碼依主題拆成幾個 PR，每個 PR 的說明寫了要解決的問題、做法、取捨和怎麼驗證。\
The code is split by topic into a few PRs, and each PR description covers the problem, the approach, the trade-offs and how it was verified.

## 依主題閱讀 Read by topic

| 主題<br>Topic | PR | 內容<br>What is in it |
|---|---|---|
| 系統設計<br>System design | [#1](https://github.com/playcsgo/demo-shop-showcase/pull/1) | 前台、BFF（NestJS 和 Next.js 兩個版本）、Kubernetes 部署（Helm、Terraform）<br>Storefront, BFF (NestJS and Next.js versions), Kubernetes deployment (Helm, Terraform) |
| 交易正確性<br>Transaction correctness | [#2](https://github.com/playcsgo/demo-shop-showcase/pull/2) | 核心 API（Laravel）、Outbox／Inbox、Saga 補償、對帳、串接服務和模擬廠商<br>Core API (Laravel), outbox / inbox, saga compensation, reconciliation, integration hub and mock vendors |
| AI 輔助客服<br>AI-assisted support | [#3](https://github.com/playcsgo/demo-shop-showcase/pull/3) | Ask／Join 兩種模式、每次呼叫獨立的 session、白名單工具<br>Ask and Join modes, an isolated session per call, allow-listed tools |
| 壓力測試與 sandbox<br>Load testing and sandbox | [#4](https://github.com/playcsgo/demo-shop-showcase/pull/4) | 封閉的測試環境、故障情境、k6 壓測、Go 版下單路徑<br>Sealed test environments, fault scenarios, k6 load tests, the Go checkout path |
| 經銷商叫貨<br>Distributor ordering | [#5](https://github.com/playcsgo/demo-shop-showcase/pull/5) | 獨立的 B2B 叫貨系統<br>A separate B2B ordering system |

## 服務 Services

| 服務<br>Service | 技術<br>Stack | 說明<br>Role |
|---|---|---|
| storefront | Vite＋React 19 | 前台<br>Storefront |
| bff-gateway | NestJS | 登入狀態（httpOnly cookie＋Redis）、轉發、聚合<br>Login state (httpOnly cookie + Redis), forwarding, aggregation |
| web-next | Next.js 16 | 前台＋BFF 的另一個版本，用 `WEB_RUNTIME` 切換<br>Alternative storefront + BFF, switched with `WEB_RUNTIME` |
| core-api | Laravel 12、PHP-FPM | 業務規則和後台（Filament）；relay、worker、scheduler 是同一份程式的背景程序<br>Business rules and the Filament admin; relay, worker and scheduler run the same code in the background |
| core-go | Go | 只改寫下單路徑，用 `CORE_RUNTIME` 切換<br>Rewrite of the checkout path only, switched with `CORE_RUNTIME` |
| hub | NestJS | 呼叫廠商、接收 webhook、重試、斷路器<br>Vendor calls, webhooks, retries, circuit breaker |
| partners | Fastify | 模擬金流、物流、醫院、LINE，可以注入故障<br>Mock payment, logistics, vet clinic and LINE, with fault injection |
| support | NestJS＋socket.io、Claude | AI 輔助客服<br>AI-assisted customer support |
| distributor | Laravel＋Filament、React | 經銷商叫貨<br>Distributor ordering |

## 啟動 Run

需要 Docker。\
Requires Docker.

```bash
cp .env.example .env                                            # 開關說明都在裡面 / every switch is explained inside
scripts/up.sh --build
docker compose exec core-api php artisan auth:keys              # 產生 JWT 金鑰 / generate JWT keys
docker compose exec core-api php artisan migrate:fresh --seed
```

| 網址<br>URL | 內容<br>What |
|---|---|
| http://localhost:15173 | 前台<br>Storefront |
| http://localhost:18080/admin | 後台<br>Admin |
| http://localhost:14000 | 廠商控制台（故障注入）<br>Vendor console (fault injection) |

Kubernetes 版本用一個指令開起來，包含 kind 叢集、Traefik、KEDA、log 系統和應用程式。\
The Kubernetes version comes up with one command: a kind cluster, Traefik, KEDA, logging and the apps.

需要 kind、kubectl、Terraform 和 node。\
It needs kind, kubectl, Terraform and node.

```bash
scripts/bootstrap.sh
```

## 測試 Tests

```bash
docker compose exec core-api ./vendor/bin/pest
scripts/sandbox.sh run --parallel 2          # 8 個正確性情境，CI 也跑這個 / 8 correctness scenarios, also run in CI
scripts/sandbox.sh run load --rps 5,10,20    # 壓力測試，只在本機跑 / load test, local only
```

## 測試帳號 Test accounts

密碼都是 `0204`，全部是虛構資料。\
The password is `0204` for all of them, and all data is fictional.

| 帳號<br>Account | 用途<br>Use |
|---|---|
| `alice@example.test`、`bob@example.test` | 顧客<br>Customers |
| `admin@example.test` | 後台管理員<br>Admin |
