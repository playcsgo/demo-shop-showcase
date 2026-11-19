-- AIC-014：商品、庫存、訂單、退款、包裹都改由商店（core-api）提供，support 不再存一份。
-- 只留物流的 demo 開關（settings），AIC-017 再搬到 partners。順序照外鍵：先刪參照別人的表
DROP TABLE IF EXISTS refund_items;
DROP TABLE IF EXISTS refunds;
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS feeding_guides;
DROP TABLE IF EXISTS stock;
DROP TABLE IF EXISTS product_variants;
DROP TABLE IF EXISTS products;
