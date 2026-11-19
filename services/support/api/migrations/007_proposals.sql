-- 退款（shop 模組）和 AI 的提案（AIC-009）
CREATE TABLE refunds (
  id CHAR(36) PRIMARY KEY,
  order_no VARCHAR(20) NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL UNIQUE, -- 重試和併發都只會有一筆，由資料庫保證
  amount INT UNSIGNED NOT NULL,
  reason VARCHAR(100) NOT NULL,
  agent_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT refunds_order FOREIGN KEY (order_no) REFERENCES orders (order_no)
);

CREATE TABLE refund_items (
  refund_id CHAR(36) NOT NULL,
  order_item_id BIGINT UNSIGNED NOT NULL,
  qty INT UNSIGNED NOT NULL,
  PRIMARY KEY (refund_id, order_item_id),
  CONSTRAINT refund_items_refund FOREIGN KEY (refund_id) REFERENCES refunds (id),
  CONSTRAINT refund_items_item FOREIGN KEY (order_item_id) REFERENCES order_items (id)
);

CREATE TABLE proposals (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  run_id CHAR(36) NOT NULL,
  type VARCHAR(30) NOT NULL, -- 目前只有 refund
  params_json JSON NOT NULL,
  judgment TEXT NOT NULL,
  reason TEXT NOT NULL,
  refs_json JSON NULL,
  preview_json JSON NOT NULL, -- 金額由 shop 算，不採用模型講的
  status VARCHAR(20) NOT NULL, -- pending | approving | executed | rejected_by_shop | rejected
  claimed_at DATETIME(3) NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME(3) NULL,
  result_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT proposals_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  INDEX proposals_conversation (conversation_id, status)
);
