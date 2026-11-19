-- AIC-015：客戶帳號在商店，support 不存密碼。customer_id 都是商店的客戶 id（不設外鍵）。
-- shop_customers 只是名字的快取（控制台顯示誰在等），每次解析商店登入時更新
DROP TABLE IF EXISTS customers;
CREATE TABLE shop_customers (
  id BIGINT UNSIGNED PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
