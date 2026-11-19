# bff-gateway

前台和核心 API 之間的 BFF（NestJS）。\
The BFF between the storefront and the core API (NestJS).

它只管登入狀態、轉發和聚合，不放任何業務規則。\
It handles login state, forwarding and aggregation, and holds no business rules.

## 做什麼 What it does

- 瀏覽器只拿到 httpOnly cookie 裡的隨機 session 編號，JWT 留在 Redis。\
  The browser only gets a random session id in an httpOnly cookie; the JWT stays in Redis.
- JWT 用核心的公鑰（JWKS）驗證，快過期時才向核心換新。\
  JWTs are verified with the core's public keys (JWKS) and refreshed from the core shortly before they expire.
- 呼叫核心只有一個入口，逾時、憑證、追蹤號碼和錯誤格式都在這裡處理。\
  There is a single way into the core, which handles timeouts, credentials, correlation ids and the error format.
- 會員總覽一支 API 平行查訂單、寄倉和訂閱，一塊失敗只降級那一塊。\
  The account overview queries orders, stored stock and subscriptions in parallel, and one failing part only degrades that part.

## 重點檔案 Key files

| 檔案<br>File | 內容<br>What it does |
|---|---|
| `src/auth/session.service.ts` | session 和 JWT 的保存、換新<br>Stores and refreshes sessions and JWTs |
| `src/auth/jwks.service.ts` | 用核心的公鑰驗證 JWT<br>Verifies JWTs with the core's public keys |
| `src/core/core-client.service.ts` | 呼叫核心的唯一入口<br>The single way into the core |
| `src/shop/overview.controller.ts` | 會員總覽的平行聚合<br>Parallel aggregation for the account overview |
| `src/common/correlation.middleware.ts` | 每個請求帶同一個追蹤號碼<br>One correlation id per request |
| `src/internal/session-resolve.controller.ts` | 給 AI 客服查詢目前登入的客戶<br>Lets AI support look up the signed-in customer |

## 測試 Tests

```bash
docker run --rm -v "$PWD":/app -w /app node:24-alpine npx vitest run
```
