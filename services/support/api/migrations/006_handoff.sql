-- 轉接：AI 沒把握就交給真人（AIC-006）
CREATE TABLE handoffs (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  reason_code VARCHAR(30) NOT NULL,
  queue VARCHAR(10) NOT NULL,
  flagged_attack TINYINT(1) NOT NULL DEFAULT 0, -- AC-17：疑似套取資料，只給客服看
  summary TEXT NULL, -- 摘要失敗時為空，仍然轉接
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT handoffs_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  INDEX handoffs_conversation (conversation_id)
);

-- AC-18：沒有人在線時的待回覆單
CREATE TABLE pending_tickets (
  conversation_id CHAR(36) PRIMARY KEY,
  queue VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL, -- open | taken
  taken_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT pending_tickets_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);
