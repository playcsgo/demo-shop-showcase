CREATE TABLE customers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE staff (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- cookie 只放隨機值，這裡存雜湊：資料庫外洩也不能直接登入
CREATE TABLE sessions (
  token_hash CHAR(64) PRIMARY KEY,
  kind VARCHAR(10) NOT NULL,
  subject_id BIGINT UNSIGNED NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE conversations (
  id CHAR(36) PRIMARY KEY,
  mode VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL,
  session_hash CHAR(64) NOT NULL,
  customer_id BIGINT UNSIGNED NULL,
  queue VARCHAR(10) NULL,
  assigned_agent_id BIGINT UNSIGNED NULL,
  join_enabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX conversations_status_queue (status, queue),
  INDEX conversations_customer (customer_id)
);

CREATE TABLE messages (
  id CHAR(36) PRIMARY KEY,
  seq BIGINT UNSIGNED AUTO_INCREMENT UNIQUE, -- 排序用：同一毫秒寫入的訊息，只靠時間排不出順序
  conversation_id CHAR(36) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  sender_id BIGINT UNSIGNED NULL,
  visibility VARCHAR(10) NOT NULL,
  body TEXT NOT NULL,
  attachment_key VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  INDEX messages_conversation_seq (conversation_id, seq)
);
