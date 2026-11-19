# core-api

核心 API（Laravel 12）：所有業務規則和資料都在這裡。\
The core API (Laravel 12): every business rule and all the data live here.

它不直接呼叫任何外部廠商，只送出指令、接收結果。\
It never calls an external vendor directly; it only sends commands and receives results.

## 做什麼 What it does

- 結帳：訂單、付款紀錄、預留庫存和送給金流的指令寫在同一筆交易（Outbox）。\
  Checkout writes the order, the payment record, the stock reservation and the payment command in one transaction (outbox).
- 背景程序是同一份程式：relay 把 outbox 送進佇列，worker 處理廠商的結果（Inbox），scheduler 跑訂閱和對帳。\
  The background processes run the same code: the relay sends the outbox to the queue, the worker handles vendor results (inbox), and the scheduler runs subscriptions and reconciliation.
- 後台用 Filament，權限分兩層：能做什麼，以及能看哪些品牌。\
  The admin uses Filament with two layers of permissions: what you can do, and which brands you can see.
- 10 項不變式隨時可以檢查帳是否一致，後台也有同一份儀表板。\
  Ten invariants can check the books at any time, with the same checks on an admin dashboard.

## 重點檔案 Key files

| 檔案<br>File | 內容<br>What it does |
|---|---|
| `app/Domain/Checkout/CheckoutService.php` | 結帳交易<br>The checkout transaction |
| `app/Domain/Messaging/` | Outbox 和 Inbox<br>Outbox and inbox |
| `app/Domain/Idempotency/` | 冪等鍵<br>Idempotency keys |
| `app/Domain/Payments/` | 付款結果和 Saga 補償<br>Payment results and saga compensation |
| `app/Domain/Reconciliation/` | 對帳和不變式<br>Reconciliation and invariants |
| `app/Console/Commands/` | relay、worker、scheduler 的指令<br>Commands for the relay, worker and scheduler |
| `app/Policies/` | 後台權限<br>Admin permissions |

## 測試 Tests

```bash
docker compose exec core-api ./vendor/bin/pest
```
