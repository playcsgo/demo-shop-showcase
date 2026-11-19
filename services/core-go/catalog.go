package main

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// 商品目錄：和 PHP 一樣 Redis cache-aside 5 分鐘。鍵另外一組（PHP 存的是 PHP 序列化格式，Go 讀不了）
// 所以後台改商品時，Go 版要等快取過期才看得到（最多 5 分鐘）
const catalogCacheKey = "core-go:catalog:v3"

func (s *server) catalog(r *reqCtx, _ []string) error {
	ctx := r.r.Context()
	if cached, err := s.redis.Get(ctx, catalogCacheKey).Bytes(); err == nil {
		r.status = 200
		r.w.Header().Set("Content-Type", "application/json")
		r.w.Write(cached)
		return nil
	}
	data, err := s.loadCatalog(r)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"data": data})
	if err != nil {
		return err
	}
	s.redis.Set(ctx, catalogCacheKey, body, 300*time.Second)
	r.status = 200
	r.w.Header().Set("Content-Type", "application/json")
	r.w.Write(append(body, '\n'))
	return nil
}

func (s *server) loadCatalog(r *reqCtx) ([]ordered, error) {
	ctx := r.r.Context()
	// 依 法人 → 品牌 → 商品 排序（Product::orderByOwner）
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.name, p.image_path, p.delivery_modes, b.project_code, b.name
		FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.status = 'active' ORDER BY b.legal_entity_id, p.brand_id, p.id`)
	if err != nil {
		return nil, err
	}
	type product struct {
		id                    int64
		name, code, brandName string
		image                 sql.NullString
		modes                 json.RawMessage
		variants              []ordered
	}
	var products []*product
	byID := map[int64]*product{}
	for rows.Next() {
		p := &product{}
		var modes []byte
		if err := rows.Scan(&p.id, &p.name, &p.image, &modes, &p.code, &p.brandName); err != nil {
			rows.Close()
			return nil, err
		}
		p.modes = json.RawMessage(modes)
		products = append(products, p)
		byID[p.id] = p
	}
	rows.Close()
	if len(products) == 0 {
		return []ordered{}, nil
	}

	// 庫存：所有桶加總。服務類商品沒有庫存紀錄 → 一律有貨
	stock := map[int64]int{}
	srows, err := s.db.QueryContext(ctx, "SELECT variant_id, SUM(on_hand - reserved) FROM inventory GROUP BY variant_id")
	if err != nil {
		return nil, err
	}
	for srows.Next() {
		var id int64
		var avail int
		srows.Scan(&id, &avail)
		stock[id] = avail
	}
	srows.Close()

	ids := make([]any, 0, len(products))
	for _, p := range products {
		ids = append(ids, p.id)
	}
	vrows, err := s.db.QueryContext(ctx, "SELECT id, product_id, sku, price, shipping_class FROM product_variants WHERE product_id IN ("+placeholders(len(ids))+") ORDER BY product_id, id", ids...)
	if err != nil {
		return nil, err
	}
	for vrows.Next() {
		var id, productID int64
		var sku, class string
		var price int
		if err := vrows.Scan(&id, &productID, &sku, &price, &class); err != nil {
			vrows.Close()
			return nil, err
		}
		avail, has := stock[id]
		inStock := class == "service" || (has && avail > 0)
		byID[productID].variants = append(byID[productID].variants,
			ordered{{"id", id}, {"sku", sku}, {"price", price}, {"shipping_class", class}, {"in_stock", inStock}})
	}
	vrows.Close()

	out := make([]ordered, 0, len(products))
	for _, p := range products {
		var image any
		if p.image.Valid {
			image = s.cfg.assetURL + "/" + strings.TrimLeft(p.image.String, "/")
		}
		variants := p.variants
		if variants == nil {
			variants = []ordered{}
		}
		out = append(out, ordered{{"id", p.id}, {"name", p.name}, {"image_url", image},
			{"brand", ordered{{"code", p.code}, {"name", p.brandName}}}, {"delivery_modes", p.modes}, {"variants", variants}})
	}
	return out, nil
}
