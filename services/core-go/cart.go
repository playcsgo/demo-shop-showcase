package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
)

var fulfillmentTypes = []string{"direct", "warehouse", "subscription", "booking"}

type cartItem struct {
	id, variantID int64
	qty           int
	fulfillment   string
	appointmentAt sql.NullTime
	holdID        sql.NullString
	holdExpiresAt sql.NullTime
	name, brand   string
	price         int
	isLitter      bool
}

// 購物車（和 CartService::cartOf 一樣：沒有就建立）
func cartOf(ctx context.Context, q queryer, customerID int64) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, "SELECT id FROM carts WHERE customer_id = ?", customerID).Scan(&id)
	if err == sql.ErrNoRows {
		t := now()
		if _, err := q.ExecContext(ctx, "INSERT IGNORE INTO carts (customer_id, created_at, updated_at) VALUES (?, ?, ?)", customerID, t, t); err != nil {
			return 0, err
		}
		err = q.QueryRowContext(ctx, "SELECT id FROM carts WHERE customer_id = ?", customerID).Scan(&id)
	}
	return id, err
}

func cartItems(ctx context.Context, q queryer, cartID int64) ([]cartItem, error) {
	rows, err := q.QueryContext(ctx, `SELECT ci.id, ci.variant_id, ci.qty, ci.fulfillment_type, ci.appointment_at, ci.hold_id, ci.hold_expires_at,
			v.name, v.price, v.is_litter, b.project_code
		FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id
		WHERE ci.cart_id = ? ORDER BY ci.variant_id, ci.fulfillment_type`, cartID) // PHP 沒有指定排序，MySQL 照唯一鍵（cart_id, variant_id, fulfillment_type）回傳；Go 寫明同一個順序
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []cartItem
	for rows.Next() {
		var it cartItem
		if err := rows.Scan(&it.id, &it.variantID, &it.qty, &it.fulfillment, &it.appointmentAt, &it.holdID, &it.holdExpiresAt,
			&it.name, &it.price, &it.isLitter, &it.brand); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

// 購物車組合規則（和 PHP 的 CartRules 相同）
func assertCombinable(items []cartItem) error {
	var subs, bookings, litterWarehouse int
	for _, it := range items {
		switch {
		case it.fulfillment == "subscription":
			subs++
		case it.fulfillment == "booking":
			bookings++
		case it.fulfillment == "warehouse" && it.isLitter:
			litterWarehouse++
		}
	}
	switch {
	case subs > 0 && len(items) > 1:
		return domainErr("subscription_must_checkout_alone", "訂閱商品需單獨結帳")
	case bookings > 0 && len(items) > 1:
		return domainErr("booking_must_checkout_alone", "預約服務需單獨結帳（先保留時段，醫院確認後才請款）")
	case litterWarehouse > 0 && litterWarehouse != len(items):
		return domainErr("litter_warehouse_must_checkout_alone", "寄倉貓砂不能和其他商品同一張訂單")
	}
	return nil
}

func iso8601(t sql.NullTime) any {
	if !t.Valid {
		return nil
	}
	return t.Time.UTC().Format("2006-01-02T15:04:05-07:00")
}

// CartResource
func cartJSON(items []cartItem) ordered {
	list := make([]ordered, 0, len(items))
	subtotal := 0
	for _, it := range items {
		list = append(list, ordered{{"id", it.id}, {"variant_id", it.variantID}, {"name", it.name}, {"brand", it.brand},
			{"unit_price", it.price}, {"qty", it.qty}, {"fulfillment_type", it.fulfillment},
			{"appointment_at", iso8601(it.appointmentAt)}, {"hold_expires_at", iso8601(it.holdExpiresAt)}})
		subtotal += it.price * it.qty
	}
	return ordered{{"items", list}, {"subtotal", subtotal}}
}

func (s *server) cartShow(r *reqCtx, _ []string) error {
	ctx := r.r.Context()
	cartID, err := cartOf(ctx, s.db, r.customer.id)
	if err != nil {
		return err
	}
	items, err := cartItems(ctx, s.db, cartID)
	if err != nil {
		return err
	}
	return r.json(200, cartJSON(items))
}

func (s *server) cartPut(r *reqCtx, _ []string) error {
	ctx := r.r.Context()
	body, _ := readBody(r.r)
	v := &validationError{}
	variantID := validInt(v, body, "variant_id", true)
	if variantID != nil {
		var n int
		s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM product_variants WHERE id = ?", *variantID).Scan(&n)
		if n == 0 {
			v.add("variant_id", "The selected variant id is invalid.")
			variantID = nil
		}
	}
	typ := validString(v, body, "fulfillment_type", true, 0)
	if typ != nil && !slices.Contains(fulfillmentTypes, *typ) {
		v.add("fulfillment_type", "The selected fulfillment type is invalid.")
	}
	qty := validInt(v, body, "qty", true)
	if qty != nil && *qty < 1 {
		v.add("qty", "The qty field must be at least 1.")
	} else if qty != nil && *qty > 99 {
		v.add("qty", "The qty field must not be greater than 99.")
	}
	if raw, ok := body["appointment_at"]; ok && string(raw) != "null" {
		var t string
		if json.Unmarshal(raw, &t) != nil {
			v.add("appointment_at", "The appointment at field must be a valid date.")
		} else if _, err := time.Parse(time.RFC3339, t); err != nil {
			v.add("appointment_at", "The appointment at field must be a valid date.")
		}
	}
	if v.failed() {
		return v
	}
	// 預約要先向醫院（經 hub）保留時段，壓測不會用到，Go 版沒有實作
	if *typ == "booking" {
		return domainErr("not_supported_in_go", "Go 版 core-api 只支援壓測的購物流程，預約請切回 PHP 版", 501)
	}

	var status, name string
	var modes []byte
	if err := s.db.QueryRowContext(ctx, `SELECT p.status, p.delivery_modes, v.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
		*variantID).Scan(&status, &modes, &name); err != nil {
		return err
	}
	if status != "active" {
		return domainErr("product_inactive", "商品已下架")
	}
	var allowed []string
	json.Unmarshal(modes, &allowed)
	if !slices.Contains(allowed, *typ) {
		return domainErr("fulfillment_not_allowed", fmt.Sprintf("%s 不支援 %s", name, *typ))
	}

	cartID, err := cartOf(ctx, s.db, r.customer.id)
	if err != nil {
		return err
	}
	t := now()
	// updateOrCreate：同一個商品＋交付方式只有一列（唯一鍵 cart_id, variant_id, fulfillment_type）
	if _, err := s.db.ExecContext(ctx, `INSERT INTO cart_items (cart_id, variant_id, fulfillment_type, qty, appointment_at, hold_id, hold_expires_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
		ON DUPLICATE KEY UPDATE qty = VALUES(qty), appointment_at = NULL, hold_id = NULL, hold_expires_at = NULL, updated_at = VALUES(updated_at)`,
		cartID, *variantID, *typ, *qty, t, t); err != nil {
		return err
	}
	items, err := cartItems(ctx, s.db, cartID)
	if err != nil {
		return err
	}
	if err := assertCombinable(items); err != nil {
		s.db.ExecContext(ctx, "DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ? AND fulfillment_type = ?", cartID, *variantID, *typ)
		return err
	}
	return r.json(200, cartJSON(items))
}

func (s *server) cartRemove(r *reqCtx, params []string) error {
	ctx := r.r.Context()
	itemID, _ := strconv.ParseInt(params[0], 10, 64)
	cartID, err := cartOf(ctx, s.db, r.customer.id)
	if err != nil {
		return err
	}
	err = withTx(ctx, s.db, func(tx *sql.Tx) error {
		var hold sql.NullString
		tx.QueryRowContext(ctx, "SELECT hold_id FROM cart_items WHERE cart_id = ? AND id = ?", cartID, itemID).Scan(&hold)
		if _, err := tx.ExecContext(ctx, "DELETE FROM cart_items WHERE cart_id = ? AND id = ?", cartID, itemID); err != nil {
			return err
		}
		if hold.Valid { // 預約的保留還給醫院（PHP 版加進來的預約商品也能刪）
			_, err := outboxRecord(ctx, tx, "booking.release.requested", "core-commands",
				ordered{{"hold_id", hold.String}, {"reason", "cart_removed"}}, uuid.NewString())
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	items, err := cartItems(ctx, s.db, cartID)
	if err != nil {
		return err
	}
	return r.json(200, cartJSON(items))
}
