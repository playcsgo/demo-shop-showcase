-- AI 的每次執行和工具呼叫。完整內容只放這裡，不進 log（AC-26）
CREATE TABLE ai_runs (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  kind VARCHAR(10) NOT NULL, -- ask | gate | join | summary
  actor VARCHAR(10) NOT NULL, -- customer | agent
  agent_id BIGINT UNSIGNED NULL,
  model_tier VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL, -- running | done | cancelled | error
  error_code VARCHAR(30) NULL,
  decision_json JSON NULL,
  ttft_ms INT NULL,
  total_ms INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ai_runs_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  INDEX ai_runs_conversation (conversation_id, created_at)
);

CREATE TABLE tool_calls (
  id CHAR(36) PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  tool VARCHAR(50) NOT NULL,
  agent_id BIGINT UNSIGNED NULL, -- AC-6：客服查詢留下是誰
  args_json JSON NOT NULL,
  result_json JSON NULL,
  status VARCHAR(10) NOT NULL, -- ok | denied | not_found | invalid | error
  duration_ms INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT tool_calls_run FOREIGN KEY (run_id) REFERENCES ai_runs (id),
  INDEX tool_calls_run (run_id)
);

-- AI 回答引用的資料，存當時工具回傳的內容：核對的是 AI 當時看到的
ALTER TABLE messages ADD COLUMN refs_json JSON NULL;
-- AC-2：匿名問訂單時只顯示一次登入按鈕
ALTER TABLE conversations ADD COLUMN login_prompted_at DATETIME(3) NULL;
