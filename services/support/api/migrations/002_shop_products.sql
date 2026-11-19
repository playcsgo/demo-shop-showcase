-- shop 模組：模擬商店的商品。數字都在這裡，敘述在 data/products/*.md
CREATE TABLE products (
  slug VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

-- 一個商品有多種口味和規格，每個組合是一個 SKU
CREATE TABLE product_variants (
  sku VARCHAR(100) PRIMARY KEY,
  product_slug VARCHAR(100) NOT NULL,
  flavor VARCHAR(50) NULL,
  size_label VARCHAR(50) NOT NULL,
  price INT UNSIGNED NOT NULL, -- 新台幣，沒有小數
  currency CHAR(3) NOT NULL,
  shipping_class VARCHAR(10) NOT NULL,
  net_weight_g INT UNSIGNED NULL,
  length_mm INT UNSIGNED NULL,
  width_mm INT UNSIGNED NULL,
  height_mm INT UNSIGNED NULL,
  shelf_life_days INT UNSIGNED NULL,
  storage VARCHAR(255) NULL,
  packaging VARCHAR(50) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT product_variants_product FOREIGN KEY (product_slug) REFERENCES products (slug),
  INDEX product_variants_slug (product_slug)
);

CREATE TABLE stock (
  sku VARCHAR(100) PRIMARY KEY,
  on_hand INT NOT NULL,
  reserved INT NOT NULL DEFAULT 0,
  CONSTRAINT stock_variant FOREIGN KEY (sku) REFERENCES product_variants (sku)
);

CREATE TABLE feeding_guides (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_slug VARCHAR(100) NOT NULL,
  size_label VARCHAR(50) NOT NULL,
  weight_min_kg DECIMAL(5, 2) NOT NULL,
  weight_max_kg DECIMAL(5, 2) NOT NULL,
  amount_min DECIMAL(6, 2) NOT NULL,
  amount_max DECIMAL(6, 2) NOT NULL,
  unit VARCHAR(10) NOT NULL,
  note VARCHAR(255) NULL,
  CONSTRAINT feeding_guides_product FOREIGN KEY (product_slug) REFERENCES products (slug),
  INDEX feeding_guides_slug (product_slug)
);
