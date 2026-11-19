-- 測試用的資料庫：測試會清空資料表，不能和 demo 資料共用
CREATE DATABASE IF NOT EXISTS support_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON support_test.* TO 'support'@'%';
