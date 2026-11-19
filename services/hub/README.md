# hub

串接服務（NestJS）：替核心呼叫外部廠商，也接收廠商的 webhook。\
The integration hub (NestJS): it calls external vendors for the core and receives their webhooks.

核心和 hub 之間只走佇列，兩邊只約定事件的格式。\
The core and the hub talk only through queues and agree only on the event format.

## 做什麼 What it does

- 從佇列取出指令（例如 `payment.requested`），呼叫對應的廠商。\
  It takes commands such as `payment.requested` off the queue and calls the right vendor.
- 每個廠商一組獨立的 worker，一家慢不會拖住其他家。\
  Each vendor has its own workers, so one slow vendor cannot stall the others.
- 呼叫廠商有逾時、重試和斷路器；處理失敗 5 次的訊息移到 DLQ。\
  Vendor calls have timeouts, retries and a circuit breaker; a message that fails 5 times moves to a DLQ.
- webhook 要有 HMAC 簽章和時間戳記，比對用固定時間的函式；重複的通知用 Redis 擋掉。\
  Webhooks need an HMAC signature with a timestamp, compared in constant time; duplicates are dropped with Redis.
- 驗證過的結果放回佇列，交給核心的 worker 處理。\
  Verified results go back on the queue for the core's worker.

## 重點檔案 Key files

| 檔案<br>File | 內容<br>What it does |
|---|---|
| `src/commands/` | 取出指令、呼叫廠商<br>Consumes commands and calls vendors |
| `src/common/resilience/` | 重試和斷路器<br>Retries and circuit breaker |
| `src/webhooks/webhook-signature.guard.ts` | webhook 驗簽<br>Webhook signature check |
| `src/common/envelope.ts` | 和核心約定的事件格式<br>The event format shared with the core |
| `src/partners/adapters.ts` | 各家廠商的 API 差異<br>Differences between vendor APIs |

## 測試 Tests

```bash
docker run --rm -v "$PWD":/app -w /app node:24-alpine npx vitest run
```
