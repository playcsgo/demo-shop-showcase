-- AIC-019：客服「刪除」自己接手的對話＝結束並從控制台隱藏（status = 'closed'）。
-- 訊息、轉接、提案都不刪（AC-25 要保存），只記下誰、什麼時候刪的
ALTER TABLE conversations
  ADD COLUMN closed_by BIGINT UNSIGNED NULL,
  ADD COLUMN closed_at DATETIME(3) NULL;
