package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"sort"
	"strings"
	"time"
)

// 結帳（和 PHP 的 CheckoutController＋IdempotencyStore＋CheckoutService 相同）：
//
//	同一個交易：佔住 Idempotency-Key → 建立訂單、明細、付款、outbox、最後才預留庫存 → 存下回應
//	同一個 key 重送 → 回同一個結果（Idempotent-Replayed: true）；內容不同 → 422
func (s *server) checkout(r *reqCtx, _ []string) error {
	ctx := r.r.Context()
	key := r.r.Header.Get("Idempotency-Key")
	if key == "" || len(key) > 80 {
		return domainErr("idempotency_key_required", "請帶 Idempotency-Key 標頭（最長 80 字）", 400)
	}
	body, _ := readBody(r.r)
	v := &validationError{}
	utm := ordered{}
	for _, f := range []struct {
		name string
		max  int
	}{{"utm_source", 50}, {"utm_medium", 50}, {"utm_campaign", 100}} {
		raw, present := body[f.name]
		if !present {
			continue
		}
		if string(raw) == "null" {
			utm = append(utm, kv{f.name, nil})
			continue
		}
		if val := validString(v, body, f.name, false, f.max); val != nil {
			utm = append(utm, kv{f.name, *val})
		}
	}
	if v.failed() {
		return v
	}
	corr := r.r.Header.Get("X-Correlation-Id")
	if corr == "" {
		corr = r.corr
	}
	hash := sha256.Sum256([]byte(phpJSONEncode(utm)))
	requestHash := hex.EncodeToString(hash[:])

	var respBody []byte
	status := 201
	replayed := false
	var placed *placedOrder
	err := withTx(ctx, s.db, func(tx *sql.Tx) error {
		t := now()
		res, err := tx.ExecContext(ctx, "INSERT INTO idempotency_keys (`key`, customer_id, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			key, r.customer.id, requestHash, t, t)
		if err != nil {
			return err
		}
		keyID, _ := res.LastInsertId()
		placed, err = s.placeOrder(ctx, tx, r, utm, corr)
		if err != nil {
			return err
		}
		detail, err := orderDetail(ctx, tx, placed.id)
		if err != nil {
			return err
		}
		if respBody, err = json.Marshal(detail); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE idempotency_keys SET response_code = ?, response_body = ?, updated_at = ? WHERE id = ?", 201, string(respBody), now(), keyID)
		return err
	})
	if isDuplicate(err, "idempotency_keys") {
		// 同一個 key 已經有人用過（或正在用，唯一鍵會等它提交）：回當時的結果
		var hashSaved string
		var code sql.NullInt64
		var saved sql.NullString
		if e := s.db.QueryRowContext(ctx, "SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE customer_id = ? AND `key` = ?",
			r.customer.id, key).Scan(&hashSaved, &code, &saved); e != nil {
			return err
		}
		if hashSaved != requestHash {
			return domainErr("idempotency_key_reused", "同一個 Idempotency-Key 不能用在不同的請求", 422)
		}
		respBody, status, replayed, err = []byte(saved.String), int(code.Int64), true, nil
	}
	if err != nil {
		return err
	}
	if placed != nil && !replayed {
		r.log.Info("order placed", "order_no", placed.orderNo, "total", placed.total, "items", placed.items, "capture_mode", "auto")
	}
	r.w.Header().Set("Idempotent-Replayed", map[bool]string{true: "true", false: "false"}[replayed])
	r.status = status
	r.w.Header().Set("Content-Type", "application/json")
	r.w.WriteHeader(status)
	r.w.Write(append(respBody, '\n'))
	return nil
}

type placedOrder struct {
	id      int64
	orderNo string
	total   int
	items   int
}

type checkoutLine struct {
	cartItem
	sku, class      string
	productBrandID  int64
	legalEntityID   int64
	legalEntityRole string
}

func (s *server) placeOrder(ctx context.Context, tx *sql.Tx, r *reqCtx, utm ordered, corr string) (*placedOrder, error) {
	var cartID int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM carts WHERE customer_id = ? FOR UPDATE", r.customer.id).Scan(&cartID)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	var lines []checkoutLine
	if err == nil {
		rows, err := tx.QueryContext(ctx, `SELECT ci.id, ci.variant_id, ci.qty, ci.fulfillment_type, v.name, v.price, v.is_litter, v.sku, v.shipping_class,
				p.brand_id, b.project_code, le.id, le.role
			FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
			JOIN brands b ON b.id = p.brand_id JOIN legal_entities le ON le.id = b.legal_entity_id
			WHERE ci.cart_id = ? ORDER BY ci.variant_id, ci.fulfillment_type`, cartID) // 和購物車同一個順序（訂單明細照這個順序建立）
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var l checkoutLine
			if err := rows.Scan(&l.id, &l.variantID, &l.qty, &l.fulfillment, &l.name, &l.price, &l.isLitter, &l.sku, &l.class,
				&l.productBrandID, &l.brand, &l.legalEntityID, &l.legalEntityRole); err != nil {
				rows.Close()
				return nil, err
			}
			lines = append(lines, l)
		}
		rows.Close()
	}
	if len(lines) == 0 {
		return nil, domainErr("cart_empty", "購物車是空的")
	}
	items := make([]cartItem, len(lines))
	for i, l := range lines {
		items[i] = l.cartItem
		// 預約、寄倉、訂閱的後續流程（醫院、寄倉帳本、訂閱排程）Go 版沒有實作：擋在結帳，不留下做不完的訂單
		if l.fulfillment != "direct" {
			return nil, domainErr("not_supported_in_go", "Go 版 core-api 只支援直送商品，其他交付方式請切回 PHP 版", 501)
		}
	}
	if err := assertCombinable(items); err != nil {
		return nil, err
	}

	// 先算好金額（PHP 先寫 0 再更新，結果一樣），其他寫入都做完，最後才鎖庫存
	subtotal := 0
	var shippable []planLine
	for _, l := range lines {
		subtotal += l.price * l.qty
		shippable = append(shippable, planLine{variantID: l.variantID, qty: l.qty, class: l.class})
	}
	shipping := totalFee(planShipments(shippable))
	total := subtotal + shipping
	orderNo := newOrderNo()
	t := now()
	utmVal := func(k string) any {
		for _, x := range utm {
			if x.k == k {
				return x.v
			}
		}
		return nil
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO orders (order_no, customer_id, subtotal, shipping_fee, total, subscription_id, utm_source, utm_medium, utm_campaign, correlation_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
		orderNo, r.customer.id, subtotal, shipping, total, utmVal("utm_source"), utmVal("utm_medium"), utmVal("utm_campaign"), corr, t, t)
	if err != nil {
		return nil, err
	}
	orderID, _ := res.LastInsertId()

	commission := map[int64]int{}
	for _, l := range lines {
		bps, ok := commission[l.legalEntityID]
		if !ok {
			if bps, err = commissionBps(ctx, tx, l.legalEntityID, l.legalEntityRole, t); err != nil {
				return nil, err
			}
			commission[l.legalEntityID] = bps
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_items (order_id, variant_id, sku, product_name, unit_price, qty, line_total, brand_id, legal_entity_id,
				commission_bps, shipping_class, fulfillment_type, appointment_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			orderID, l.variantID, l.sku, l.name, l.price, l.qty, l.price*l.qty, l.productBrandID, l.legalEntityID,
			bps, l.class, l.fulfillment, t, t); err != nil {
			return nil, err
		}
	}

	var merchantID int64
	var merchantCode string
	if err := tx.QueryRowContext(ctx, "SELECT id, merchant_id FROM merchant_accounts ORDER BY id LIMIT 1").Scan(&merchantID, &merchantCode); err != nil {
		return nil, err
	}
	payKey := "pay:" + orderNo
	res, err = tx.ExecContext(ctx, `INSERT INTO payments (order_id, merchant_account_id, amount, status, capture_mode, idempotency_key, created_at, updated_at)
		VALUES (?, ?, ?, 'PENDING', 'auto', ?, ?, ?)`, orderID, merchantID, total, payKey, t, t)
	if err != nil {
		return nil, err
	}
	paymentID, _ := res.LastInsertId()
	var tokenRef any
	if r.customer.paymentTokenRef.Valid {
		tokenRef = r.customer.paymentTokenRef.String
	}
	if _, err := outboxRecord(ctx, tx, "payment.requested", "core-commands", ordered{
		{"order_no", orderNo}, {"payment_id", paymentID}, {"amount", total}, {"currency", "TWD"},
		{"merchant_id", merchantCode}, {"idempotency_key", payKey}, {"capture_mode", "auto"},
		{"payment_token_ref", tokenRef},
		{"requested_at_ms", r.started.UnixMilli()}, // 客人按下結帳的時間（nginx 收到），hub 交給物流時算整筆花多久
	}.withoutNulls(), corr); err != nil {
		return nil, err
	}

	// 最後才預留庫存（鎖庫存列），依商品 id 排序：鎖的順序一致，兩筆訂單不會互等
	type reservation struct {
		variantID int64
		qty       int
	}
	var reservations []reservation
	for _, l := range lines {
		if l.class != "service" {
			reservations = append(reservations, reservation{l.variantID, l.qty})
		}
	}
	sort.SliceStable(reservations, func(i, j int) bool { return reservations[i].variantID < reservations[j].variantID })
	expires := t.Add(time.Duration(s.cfg.scaled(900)) * time.Second)
	for _, x := range reservations {
		if err := reserveStock(ctx, tx, orderID, x.variantID, x.qty, expires); err != nil {
			return nil, err
		}
	}
	// 結帳完清空購物車（同一個交易：訂單建立失敗的話購物車也還在）
	if _, err := tx.ExecContext(ctx, "DELETE FROM cart_items WHERE cart_id = ?", cartID); err != nil {
		return nil, err
	}
	return &placedOrder{orderID, orderNo, total, len(lines)}, nil
}

// LegalEntity::commissionBpsAt：平台自己不抽成；供應商用當天有效的合約
func commissionBps(ctx context.Context, tx *sql.Tx, legalEntityID int64, role string, at time.Time) (int, error) {
	if role == "platform" {
		return 0, nil
	}
	var bps sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT commission_bps FROM supplier_contracts WHERE legal_entity_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
		legalEntityID, at.Format("2006-01-02")).Scan(&bps)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	return int(bps.Int64), nil
}

// 'A' + 年月日 + 7 碼大寫英數（和 PHP 的 CheckoutService::newOrderNo 相同）
func newOrderNo() string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	var b strings.Builder
	b.WriteString("A")
	b.WriteString(time.Now().UTC().Format("060102"))
	for range 7 {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b.WriteByte(chars[n.Int64()])
	}
	return strings.ToUpper(b.String())
}

// OrderDetailResource（Go 版的訂單只有直送商品；包裹在付款成功後才建立，所以結帳當下沒有交付卡片）
func orderDetail(ctx context.Context, q queryer, orderID int64) (ordered, error) {
	var orderNo, status string
	var subtotal, shipping, total int
	var paidAt sql.NullTime
	if err := q.QueryRowContext(ctx, "SELECT order_no, status, subtotal, shipping_fee, total, paid_at FROM orders WHERE id = ?", orderID).
		Scan(&orderNo, &status, &subtotal, &shipping, &total, &paidAt); err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT oi.id, oi.product_name, oi.qty, oi.unit_price, b.project_code, oi.fulfillment_type, oi.fulfillment_status, oi.refunded_qty
		FROM order_items oi JOIN brands b ON b.id = oi.brand_id WHERE oi.order_id = ? ORDER BY oi.id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ordered{}
	for rows.Next() {
		var id int64
		var name, brand, ftype, fstatus string
		var qty, price, refunded int
		if err := rows.Scan(&id, &name, &qty, &price, &brand, &ftype, &fstatus, &refunded); err != nil {
			return nil, err
		}
		items = append(items, ordered{{"id", id}, {"name", name}, {"qty", qty}, {"unit_price", price}, {"brand", brand},
			{"fulfillment_type", ftype}, {"fulfillment_status", fstatus}, {"refunded_qty", refunded}})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ordered{{"order_no", orderNo}, {"status", status}, {"subtotal", subtotal}, {"shipping_fee", shipping}, {"total", total},
		{"paid_at", iso8601(paidAt)}, {"progress", ordered{{"done", 0}, {"total", 0}}}, {"items", items}, {"fulfillments", []any{}}}, nil
}
