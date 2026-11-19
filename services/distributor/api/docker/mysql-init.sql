-- 第一次啟動才會跑：測試用獨立的資料庫，跑測試不會清掉 demo 資料
CREATE DATABASE IF NOT EXISTS distributor_test;
GRANT ALL PRIVILEGES ON distributor_test.* TO 'distributor'@'%';
