-- 測試用資料庫（測試跑在真的 MySQL，CHECK 與鎖的行為才和正式環境一致）
CREATE DATABASE IF NOT EXISTS demo_test;
GRANT ALL PRIVILEGES ON demo_test.* TO 'demo'@'%';

-- Grafana 用的唯讀帳號（M14；只限 sandbox，正式環境的儀表板要查唯讀副本）
CREATE USER IF NOT EXISTS 'grafana_ro'@'%' IDENTIFIED BY 'grafana_ro';
GRANT SELECT ON demo.* TO 'grafana_ro'@'%';
