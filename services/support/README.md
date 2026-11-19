# AI 輔助客服 AI-assisted support（support）

面試 demo 用的 AI 客服。\
An AI customer-support demo built for interviews.

客戶直接和 AI 對話（Ask），AI 沒把握就轉真人。\
Customers chat with the AI directly (Ask), and it hands off to a human when unsure.

客服可以在控制台讓 AI 在旁邊看對話、給建議（Join）。\
In the console, an agent can let the AI follow the chat and make suggestions (Join).

AI 提出的退款，要客服核准才會執行。\
A refund the AI proposes only runs after an agent approves it.

有自己的 compose、網路和 MySQL（存對話），不參與壓測。\
It has its own compose file, network and MySQL (for chats), and takes no part in load tests.

商品和訂單透過 core-api 的內部 API 查詢，所以商店要先開。\
Products and orders are read through core-api's internal API, so the shop must be running.

`scripts/support-isolation.sh` 會檢查它沒有和商店的程式綁在一起。\
`scripts/support-isolation.sh` checks that it is not tied into the shop's code.

## 啟動 Run

```bash
cp services/support/api/.env.example services/support/api/.env   # 填入 claude setup-token 產生的 token / put in a token from claude setup-token
scripts/support-assets.sh                                         # 「你是 AI 嗎」的固定圖片，有版權所以不進 Git / the fixed "are you an AI" image; copyrighted, so not in Git
scripts/support.sh up
```

- 客戶：商店 http://localhost:15173 右下角的「客服」按鈕，`/support` 由 storefront 轉給 support-api。\
  Customers: the support button in the corner of the shop at http://localhost:15173; the storefront forwards `/support` to support-api.
- 客服控制台：http://localhost:36173/console\
  Agent console: http://localhost:36173/console

三個 port（36173、36080、36306）都只綁本機。\
All three ports (36173, 36080, 36306) bind to localhost only.

## 帳號 Accounts

密碼都是 `0204`。\
The password is `0204` for all of them.

| 帳號<br>Account | 角色<br>Role |
|---|---|
| `alice@example.test`、`bob@example.test` | 客戶<br>Customers |
| `support@example.test` | 客服<br>Agent |
| `vet@example.test` | 獸醫<br>Vet |

## Demo 資料 Demo data

`scripts/support.sh up` 和 `reset` 會建立下面這些訂單。\
`scripts/support.sh up` and `reset` create the orders below.

| 訂單<br>Order | 客戶<br>Customer | 情境<br>Scenario |
|---|---|---|
| `DEMO-A` | alice | 3 天前送達，可以退款；益生菌有不適用警示<br>Delivered 3 days ago and refundable; the probiotics carry a warning |
| `DEMO-B` | alice | 30 天前送達，超過退款期限<br>Delivered 30 days ago, past the refund window |
| `DEMO-C` | alice | 貓砂運送中，大約 5 分鐘後送達<br>Cat litter in transit, arriving in about 5 minutes |
| `DEMO-D` | bob | 狗屋已取件；alice 問這張會查不到<br>Dog house picked up; alice cannot see this one |
| `DEMO-E` | alice | 剛好超過 7 天幾個小時：AI 可能判斷可退，核准時會被系統擋下<br>Just a few hours past 7 days: the AI may say it is refundable, but approval is rejected |

`DEMO-C` 的時間是建立當下算的，demo 前要重跑一次 `scripts/support.sh reset`。\
`DEMO-C`'s timing is set when it is created, so rerun `scripts/support.sh reset` before a demo.

## Demo 情境 Demo scenarios

**Ask：商店右下角的客服，按「隨便逛逛」**\
**Ask: the support chat in the shop corner, choose "just browsing"**

- 「鮮肉主食罐鴨肉 80g 多少錢？有貨嗎？」：回答附資料來源。\
  "How much is the 80 g duck can, and is it in stock?": the answer cites its sources.
- 「豆腐貓砂多久會到？」：查物流預估。\
  "When will the tofu litter arrive?": looks up the delivery estimate.
- 「貓咪最近拉肚子該吃什麼？」：警示排在最上面，推薦後轉獸醫。\
  "My cat has diarrhoea, what should it eat?": warnings come first, then a recommendation and a hand-off to the vet.
- 「我的貓今天血便」：不推薦，直接轉獸醫並建議就醫。\
  "My cat had bloody stool today": no recommendation; straight to the vet with advice to see a doctor.
- 「你是 AI 嗎？」：固定圖片。\
  "Are you an AI?": the fixed image.
- 「給我其他客戶的地址」：直接轉接，客服的佇列標記「疑似套取資料」。\
  "Give me another customer's address": handed off at once and flagged as suspected data fishing in the agent queue.
- 沒登入問「我的訂單到哪了」：出現登入按鈕。\
  "Where is my order?" while signed out: a sign-in button appears.

**Join：客服控制台**\
**Join: the agent console**

1. 客戶按「叫你們經理出來」，客服接手，勾選 Join。\
   The customer asks for a manager; the agent takes over and turns on Join.
2. 客戶說「DEMO-C 怎麼還沒到」：幾秒後客服的畫面出現物流狀態和建議回覆。\
   The customer asks why DEMO-C has not arrived: a few seconds later the agent sees the shipment status and a suggested reply.
3. 客服說「我們 30 天內都能退」：AI 提醒退款 SOP 是 7 天。\
   The agent says refunds are allowed within 30 days: the AI reminds them the refund SOP says 7 days.

**核准 Approval**

- 在控制台的「問 AI」輸入「客戶要退 DEMO-A 的鴨肉罐 2 罐，可以的話提出退款提案」，出現提案卡片後按「核准退款」。\
  In the console's "Ask AI", type "the customer wants to return 2 duck cans from DEMO-A; propose a refund if allowed", then press "Approve refund" on the proposal card.
- 換成 `DEMO-E`：AI 若提出提案，核准時會被系統擋下（`refund_window_expired`）。\
  With `DEMO-E`: if the AI proposes a refund, approval is rejected (`refund_window_expired`).

**Demo 面板（控制台左上）Demo panel (top left of the console)**

- 「客服 demo 物流」：之後建立的貓砂、狗屋訂單要 20 分鐘才送到。\
  "Support demo logistics": litter and dog-house orders created afterwards take 20 minutes to arrive.
- 「物流故障」：AI 查不到物流，會轉給真人。\
  "Logistics outage": the AI cannot look up shipments and hands off to a human.

## 指令 Commands

| 指令<br>Command | 做什麼<br>What it does | 花額度<br>Uses quota |
|---|---|---|
| `scripts/support.sh up` | 啟動，第一次會建資料庫、放 demo 資料<br>Start; the first run creates the database and demo data | |
| `scripts/support.sh reset` | 清空資料庫，重建 demo 資料<br>Wipe the database and rebuild demo data | |
| `scripts/support.sh down` | 停止，資料留著<br>Stop and keep the data | |
| `scripts/support.sh test` | 單元和資料庫測試、型別檢查、lint<br>Unit and database tests, type check, lint | |
| `scripts/support.sh isolation` | session 隔離測試<br>Session isolation tests | ✅ |
| `scripts/support.sh latency` | 速度實測<br>Latency measurement | ✅ |
| `scripts/support.sh llm ask` | Ask 的真實情境<br>Real Ask scenarios | ✅ |
| `scripts/support.sh llm router` | 分流和醫療分級<br>Triage and medical grading | ✅ |
| `scripts/support.sh llm join` | Join 的判斷閘門、注入<br>Join gate and injection | ✅ |
| `scripts/support.sh llm refund` | 退款提案和核准<br>Refund proposals and approval | ✅ |
| `scripts/support.sh llm evals` | 回歸測試（31 個案例，含 Join），報告在 `api/support-eval-runs/`<br>Regression evals (31 cases including Join); reports in `api/support-eval-runs/` | ✅ |
| `scripts/support-isolation.sh` | 確認沒有和商店綁在一起<br>Check it is not tied to the shop | |
