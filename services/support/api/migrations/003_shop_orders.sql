-- shop 模組：模擬商店的訂單。金額都是新台幣整數
CREATE TABLE orders (
  order_no VARCHAR(20) PRIMARY KEY,
  customer_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL, -- paid | shipped | delivered | cancelled
  payment_status VARCHAR(10) NOT NULL, -- paid | unpaid
  total INT UNSIGNED NOT NULL,
  shipping_fee INT UNSIGNED NOT NULL DEFAULT 0,
  refunded_amount INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  CONSTRAINT orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  INDEX orders_customer (customer_id, created_at)
);

CREATE TABLE order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(20) NOT NULL,
  sku VARCHAR(100) NOT NULL,
  qty INT UNSIGNED NOT NULL,
  unit_price INT UNSIGNED NOT NULL,
  CONSTRAINT order_items_order FOREIGN KEY (order_no) REFERENCES orders (order_no),
  CONSTRAINT order_items_variant FOREIGN KEY (sku) REFERENCES product_variants (sku)
);
