# 經銷商叫貨服務 Distributor ordering

業務開通經銷商和合約，經銷商一次替多個 shop 下單。\
Sales set up distributors and their contracts, and a distributor orders for several shops at once.

業務接著審核、確認收款、填 ETA，再按出貨和送達。\
Sales then review the order, confirm payment, fill in the ETA and mark it shipped and delivered.

這個服務獨立於商店：有自己的商品、庫存、員工帳號和 MySQL。\
The service is separate from the shop, with its own products, stock, staff accounts and MySQL.

它不呼叫商店的任何服務，也不參與壓力測試。\
It calls no shop service and takes no part in load tests.

| 資料夾<br>Folder | 內容<br>What | 網址<br>URL |
|---|---|---|
| `api` | Laravel＋Filament：員工後台和經銷商 API<br>Laravel + Filament: staff back office and distributor API | http://localhost:28080/admin |
| `web` | React：經銷商前台<br>React: distributor site | http://localhost:25173 |

## 使用 Usage

```bash
scripts/distributor.sh up      # 啟動，第一次會裝套件、建資料庫、放 demo 資料 / start; the first run installs packages, creates the database and demo data
scripts/distributor.sh reset   # 清空資料庫，重建 demo 資料 / wipe the database and rebuild demo data
scripts/distributor.sh test    # 後端測試和 PHPStan / backend tests and PHPStan
scripts/distributor.sh down    # 停止，資料留著 / stop and keep the data
scripts/distributor-isolation.sh   # 確認和商店沒有被綁在一起 / check it is not tied to the shop
```

## Demo 帳號 Demo accounts

密碼都是 `0204`，全部是虛構資料。\
The password is `0204` for all of them, and all data is fictional.

| 角色<br>Role | 帳號<br>Account |
|---|---|
| 業務<br>Sales | `sales-a@example.test`、`sales-b@example.test` |
| 商品管理<br>Product management | `product@example.test` |
| 總管理<br>Admin | `admin@example.test` |
| 經銷商<br>Distributor | `pacific-manager@example.test`、`pacific-buyer@example.test` |

## 重要規則 Key rules

- **庫存獨立：** 只有經銷商訂單會影響這裡的庫存，和 B2C 不連動。\
  **Separate stock:** only distributor orders change stock here; it is not linked to B2C.
- **國家禁令：** 國家禁某個成分，有列就是禁令。\
  **Country bans:** if a country lists an ingredient, it is banned there.\
  下單時比對 SKU 的成分，只警告、不擋送出，決定權在業務。\
  Orders are checked against SKU ingredients; it only warns and never blocks, and sales decides.
- **HS code：** SKU 存預設值，各國可以覆蓋，只供參考，最終以貨代為準。\
  **HS codes:** each SKU stores a default that a country can override; for reference only, the freight forwarder has the final say.
- **代碼：** 經銷商代碼和 SKU 建立後不能修改。\
  **Codes:** distributor codes and SKUs cannot change after creation.
- **刪除：** 有訂單就不能刪，經銷商改成停權；沒有訂單時，連帶刪除相關設定。\
  **Deletion:** a distributor with orders cannot be deleted and is suspended instead; without orders, its settings are deleted with it.
