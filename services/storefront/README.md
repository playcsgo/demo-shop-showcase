# storefront

前台（Vite＋React 19）：商品、購物車、結帳等待頁和會員中心。\
The storefront (Vite + React 19): catalog, cart, checkout waiting page and account area.

它只呼叫 BFF，不直接碰核心 API，瀏覽器裡也沒有任何憑證。\
It only calls the BFF, never the core API, and holds no credentials in the browser.

## 重點檔案 Key files

| 檔案<br>File | 內容<br>What it does |
|---|---|
| `src/api.ts` | 呼叫 BFF 的唯一地方<br>The only place that calls the BFF |
| `src/pages/` | 各頁面<br>Pages |
| `public/CREDITS.md` | 照片和字型的來源與授權<br>Sources and licences for photos and fonts |

## 開發 Development

```bash
npm install
npm run dev
```
