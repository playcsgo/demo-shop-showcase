-- shop 模組：物流模擬。時程在建單時就寫死，之後切換 demo 開關不影響進行中的包裹
CREATE TABLE settings (
  name VARCHAR(50) PRIMARY KEY,
  value VARCHAR(50) NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE shipments (
  tracking_no VARCHAR(30) PRIMARY KEY,
  order_no VARCHAR(20) NOT NULL,
  shipping_class VARCHAR(10) NOT NULL,
  step_ms INT UNSIGNED NOT NULL, -- 每一段（已取件、運送中、已送達）的間隔
  started_at DATETIME(3) NOT NULL,
  CONSTRAINT shipments_order FOREIGN KEY (order_no) REFERENCES orders (order_no),
  INDEX shipments_order (order_no)
);
