package main

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"time"
)

// worker 處理事件時用的程式：都在 inbox 的同一個交易裡（和 PHP 的 PaymentResultHandler、FulfillmentDispatcher、
// OrderTransitions、OrderProgress、SettlementRecorder、ShipmentStatusHandler 同一套規則）
type handlers struct {
	tx          *sql.Tx
	log         ctxLogger
	cfg         config
	stages      *stageLog
	correlation string
}

// 訂單狀態機：只允許表上列的轉移，用條件式 UPDATE；回 false＝狀態已經不是預期的（重複、亂序的事件）
var allowedFrom = map[string][]string{
	"PAID":               {"PENDING_PAYMENT"},
	"PAYMENT_FAILED":     {"PENDING_PAYMENT"},
	"CANCELLED":          {"PENDING_PAYMENT", "PAID"},
	"FULFILLING":         {"PAID"},
	"COMPLETED":          {"PAID", "FULFILLING"},
	"PARTIALLY_REFUNDED": {"PAID", "FULFILLING", "COMPLETED", "PARTIALLY_REFUNDED"},
	"REFUNDED":           {"PAID", "FULFILLING", "COMPLETED", "PARTIALLY_REFUNDED", "CANCELLED"},
}

func (h *handlers) transition(ctx context.Context, orderID int64, to string, paidAt *time.Time) (bool, error) {
	from := allowedFrom[to]
	args := []any{to, now()}
	set := "status = ?, updated_at = ?"
	if paidAt != nil {
		set += ", paid_at = ?"
		args = append(args, *paidAt)
	}
	args = append(args, orderID)
	for _, f := range from {
		args = append(args, f)
	}
	n, err := execAffected(ctx, h.tx, "UPDATE orders SET "+set+" WHERE id = ? AND status IN ("+placeholders(len(from))+")", args...)
	if err != nil {
		return false, err
	}
	ok := n == 1
	if ok {
		h.log.Debug("order → "+to, "order_id", orderID, "to", to, "from", from, "applied", true)
		h.stages.add(orderID, strings.ToLower(to))
	} else {
		h.log.Debug("order → "+to+" skipped (status not in from)", "order_id", orderID, "to", to, "from", from, "applied", false)
	}
	return ok, nil
}

type orderRow struct {
	id              int64
	orderNo, status string
	total           int
	correlationID   string
	subscriptionID  sql.NullInt64
}

func (h *handlers) order(ctx context.Context, orderNo string) (*orderRow, error) {
	o := &orderRow{}
	err := h.tx.QueryRowContext(ctx, "SELECT id, order_no, status, total, correlation_id, subscription_id FROM orders WHERE order_no = ?", orderNo).
		Scan(&o.id, &o.orderNo, &o.status, &o.total, &o.correlationID, &o.subscriptionID)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("訂單 %s 不存在", orderNo)
	}
	return o, err
}

// hub 已經把扣款交給金流：PENDING → SUBMITTED，開始計時對帳
func (h *handlers) paymentSubmitted(ctx context.Context, orderNo, txnID string) error {
	var orderID int64
	if err := h.tx.QueryRowContext(ctx, "SELECT id FROM orders WHERE order_no = ?", orderNo).Scan(&orderID); err != nil && err != sql.ErrNoRows {
		return err
	}
	t := now()
	next := t.Add(time.Duration(h.cfg.scaled(envInt("PAYMENT_RECONCILE_AFTER_SECONDS", 120))) * time.Second)
	n, err := execAffected(ctx, h.tx, `UPDATE payments SET status = 'SUBMITTED', provider_txn_id = ?, submitted_at = ?, reconcile_attempts = 0, next_reconcile_at = ?, updated_at = ?
		WHERE order_id = ? AND status = 'PENDING'`, txnID, t, next, t, orderID)
	if err != nil {
		return err
	}
	if n == 1 {
		h.log.Debug("payment submitted to provider (start reconcile clock)", "order_no", orderNo)
		h.stages.add(orderID, "payment_submitted")
	} else {
		h.log.Debug("payment.submitted ignored (not PENDING)", "order_no", orderNo)
	}
	return nil
}

func (h *handlers) paymentSucceeded(ctx context.Context, orderNo, txnID string, amount int) error {
	o, err := h.order(ctx, orderNo)
	if err != nil {
		return err
	}
	if amount != o.total {
		return fmt.Errorf("金額不符：訂單 %d、金流 %d", o.total, amount) // 不自動處理，進 DLQ 由人看
	}
	paidAt := now()
	ok, err := h.transition(ctx, o.id, "PAID", &paidAt)
	if err != nil {
		return err
	}
	if !ok {
		// 訂單已經失敗或取消，付款成功卻晚到了 → 客人被扣了錢但沒有訂單 → 自動全額退款
		if o.status == "PAYMENT_FAILED" || o.status == "CANCELLED" {
			return h.refundLatePayment(ctx, o, txnID)
		}
		return nil
	}
	if _, err := h.tx.ExecContext(ctx, `UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ?, succeeded_at = ?, updated_at = ?
		WHERE order_id = ? AND status IN ('PENDING', 'SUBMITTED', 'AUTHORIZED')`, txnID, paidAt, paidAt, o.id); err != nil {
		return err
	}
	if err := commitStock(ctx, h.tx, o.id); err != nil {
		return err
	}
	h.log.Info("payment succeeded → order PAID", "order_no", orderNo, "amount", amount, "provider_txn_id", txnID)
	if err := h.recordSale(ctx, o.id, paidAt); err != nil {
		return err
	}
	if err := h.dispatch(ctx, o); err != nil {
		return err
	}
	return h.subscriptionResult(ctx, o.id, true)
}

func (h *handlers) refundLatePayment(ctx context.Context, o *orderRow, txnID string) error {
	t := now()
	n, err := execAffected(ctx, h.tx, `UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ?, succeeded_at = ?, refunded_amount = amount, updated_at = ?
		WHERE order_id = ? AND status != 'SUCCEEDED'`, txnID, t, t, o.id)
	if err != nil || n == 0 {
		return err // 已補償過
	}
	var paymentID int64
	var amount int
	if err := h.tx.QueryRowContext(ctx, "SELECT id, amount FROM payments WHERE order_id = ?", o.id).Scan(&paymentID, &amount); err != nil {
		return err
	}
	key := "late-payment:" + o.orderNo
	res, err := h.tx.ExecContext(ctx, `INSERT INTO refunds (payment_id, order_id, amount, reason, status, idempotency_key, created_at, updated_at)
		VALUES (?, ?, ?, 'late_payment_after_failure', 'PENDING', ?, ?, ?)`, paymentID, o.id, amount, key, t, t)
	if err != nil {
		return err
	}
	refundID, _ := res.LastInsertId()
	if _, err := outboxRecord(ctx, h.tx, "refund.requested", "core-commands", ordered{
		{"refund_id", refundID}, {"order_no", o.orderNo}, {"provider_txn_id", txnID}, {"amount", amount}, {"idempotency_key", key},
	}, o.correlationID); err != nil {
		return err
	}
	h.log.Warn("late payment after failure, auto refund", "order_no", o.orderNo, "amount", amount)
	return nil
}

func (h *handlers) paymentFailed(ctx context.Context, orderNo, reason string) error {
	o, err := h.order(ctx, orderNo)
	if err != nil {
		return err
	}
	ok, err := h.transition(ctx, o.id, "PAYMENT_FAILED", nil)
	if err != nil || !ok {
		return err
	}
	if _, err := h.tx.ExecContext(ctx, "UPDATE payments SET status = 'FAILED', updated_at = ? WHERE order_id = ? AND status IN ('PENDING', 'SUBMITTED')", now(), o.id); err != nil {
		return err
	}
	if err := releaseStock(ctx, h.tx, o.id); err != nil { // 補償：釋放預留
		return err
	}
	h.log.Info("payment failed → release reservations and holds", "order_no", orderNo, "reason", reason)
	if err := h.cancelOpenBookings(ctx, o, "payment_failed"); err != nil {
		return err
	}
	return h.subscriptionResult(ctx, o.id, false)
}

// 預約：釋放醫院的時段（PHP 版建立的預約訂單也可能走到這裡）
func (h *handlers) cancelOpenBookings(ctx context.Context, o *orderRow, reason string) error {
	rows, err := h.tx.QueryContext(ctx, "SELECT id, order_item_id, hold_id FROM bookings WHERE order_no = ? AND status IN ('HELD', 'AUTHORIZED')", o.orderNo)
	if err != nil {
		return err
	}
	type booking struct {
		id, itemID int64
		hold       sql.NullString
	}
	var list []booking
	for rows.Next() {
		var b booking
		rows.Scan(&b.id, &b.itemID, &b.hold)
		list = append(list, b)
	}
	rows.Close()
	for _, b := range list {
		t := now()
		n, err := execAffected(ctx, h.tx, "UPDATE bookings SET status = 'CANCELLED', failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('HELD', 'AUTHORIZED')", reason, t, b.id)
		if err != nil {
			return err
		}
		if n == 0 {
			continue
		}
		if _, err := h.tx.ExecContext(ctx, "UPDATE order_items SET fulfillment_status = 'CANCELLED', updated_at = ? WHERE id = ?", t, b.itemID); err != nil {
			return err
		}
		var hold any
		if b.hold.Valid {
			hold = b.hold.String
		}
		if _, err := outboxRecord(ctx, h.tx, "booking.release.requested", "core-commands", ordered{{"hold_id", hold}, {"reason", reason}}, o.correlationID); err != nil {
			return err
		}
	}
	return nil
}

// SubscriptionRunner::onPaymentResult：這張訂單是訂閱的某一期才需要處理（Go 版建立的訂單不會是）
func (h *handlers) subscriptionResult(ctx context.Context, orderID int64, succeeded bool) error {
	var cycleID, subID int64
	err := h.tx.QueryRowContext(ctx, "SELECT id, subscription_id FROM subscription_cycles WHERE order_id = ? LIMIT 1", orderID).Scan(&cycleID, &subID)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	status := map[bool]string{true: "PAID", false: "FAILED"}[succeeded]
	if _, err := h.tx.ExecContext(ctx, "UPDATE subscription_cycles SET status = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'", status, now(), cycleID); err != nil {
		return err
	}
	if succeeded {
		_, err = h.tx.ExecContext(ctx, "UPDATE subscriptions SET consecutive_failures = 0 WHERE id = ?", subID)
		return err
	}
	if _, err := h.tx.ExecContext(ctx, "UPDATE subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE id = ?", subID); err != nil {
		return err
	}
	_, err = h.tx.ExecContext(ctx, "UPDATE subscriptions SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND consecutive_failures >= 3", now(), subID)
	return err
}

// 結算分錄：只有供應商的明細記 SALE（＋）、COMMISSION（−）、PAYMENT_FEE（−）。重複呼叫安全（idempotency_key 唯一）
func (h *handlers) recordSale(ctx context.Context, orderID int64, paidAt time.Time) error {
	rows, err := h.tx.QueryContext(ctx, `SELECT oi.id, oi.legal_entity_id, oi.brand_id, oi.line_total, oi.commission_bps, le.role
		FROM order_items oi JOIN legal_entities le ON le.id = oi.legal_entity_id WHERE oi.order_id = ? ORDER BY oi.id`, orderID)
	if err != nil {
		return err
	}
	type item struct {
		id, entity, brand int64
		lineTotal, bps    int
		role              string
	}
	var items []item
	for rows.Next() {
		var it item
		rows.Scan(&it.id, &it.entity, &it.brand, &it.lineTotal, &it.bps, &it.role)
		items = append(items, it)
	}
	rows.Close()
	feeBps := 200
	for _, it := range items {
		if it.bps == 0 && it.role != "supplier" {
			continue // 汪自己的品牌
		}
		for _, e := range []struct {
			typ, key string
			amount   int
		}{
			{"SALE", fmt.Sprintf("sale:%d", it.id), it.lineTotal},
			{"COMMISSION", fmt.Sprintf("commission:%d", it.id), -bps(it.lineTotal, it.bps)},
			{"PAYMENT_FEE", fmt.Sprintf("fee:%d", it.id), -bps(it.lineTotal, feeBps)},
		} {
			if _, err := h.tx.ExecContext(ctx, `INSERT IGNORE INTO settlement_entries (legal_entity_id, brand_id, type, amount, ref_type, ref_id, occurred_at, idempotency_key, created_at)
				VALUES (?, ?, ?, ?, 'order_item', ?, ?, ?, ?)`, it.entity, it.brand, e.typ, e.amount, it.id, paidAt, e.key, now()); err != nil {
				return err
			}
		}
	}
	return nil
}

// 萬分比、無條件捨去（尾差留在汪）
func bps(amount, bps int) int { return amount * bps / 10000 }

// 付款成功後出貨：直送依 shipping_class 拆包裹，每包一則 shipment.requested
func (h *handlers) dispatch(ctx context.Context, o *orderRow) error {
	rows, err := h.tx.QueryContext(ctx, "SELECT id, variant_id, qty, sku, product_name, fulfillment_type, shipping_class FROM order_items WHERE order_id = ? ORDER BY id", o.id)
	if err != nil {
		return err
	}
	type item struct {
		id, variantID           int64
		qty                     int
		sku, name, ftype, class string
	}
	items := map[int64]item{}
	var lines []planLine
	var unsupported []string
	for rows.Next() {
		var it item
		rows.Scan(&it.id, &it.variantID, &it.qty, &it.sku, &it.name, &it.ftype, &it.class)
		items[it.id] = it
		switch it.ftype {
		case "direct":
			lines = append(lines, planLine{key: it.id, variantID: it.variantID, qty: it.qty, class: it.class})
		default:
			unsupported = append(unsupported, it.ftype)
		}
	}
	rows.Close()
	if len(unsupported) > 0 {
		return fmt.Errorf("Go 版 core-worker 只出貨直送商品，這張訂單有 %s（請切回 PHP 版）", strings.Join(slices.Compact(unsupported), "、"))
	}
	for i, p := range planShipments(lines) {
		seq := i + 1
		t := now()
		res, err := h.tx.ExecContext(ctx, `INSERT INTO shipments (order_id, seq, shipping_class, carrier, status, shipping_fee, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`, o.id, seq, p.class, p.carrier, p.fee, t, t)
		if err != nil {
			return err
		}
		shipmentID, _ := res.LastInsertId()
		payloadItems := []ordered{}
		for _, l := range p.lines {
			if _, err := h.tx.ExecContext(ctx, "INSERT INTO shipment_items (shipment_id, order_item_id, variant_id, qty) VALUES (?, ?, ?, ?)", shipmentID, l.key, l.variantID, l.qty); err != nil {
				return err
			}
			if _, err := h.tx.ExecContext(ctx, "UPDATE order_items SET fulfillment_status = 'PROCESSING' WHERE id = ? AND fulfillment_status = 'PENDING'", l.key); err != nil {
				return err
			}
			it := items[l.key]
			payloadItems = append(payloadItems, ordered{{"sku", it.sku}, {"name", it.name}, {"qty", l.qty}})
		}
		if _, err := outboxRecord(ctx, h.tx, "shipment.requested", "core-commands", ordered{
			{"shipment_id", shipmentID}, {"source", "order"}, {"order_no", o.orderNo}, {"package_seq", seq},
			{"carrier", p.carrier}, {"items", payloadItems},
		}, o.correlationID); err != nil {
			return err
		}
	}
	return h.refreshProgress(ctx, o.id)
}

// 訂單狀態由明細推導：全部結束 → COMPLETED；有任何明細開始處理 → FULFILLING
func (h *handlers) refreshProgress(ctx context.Context, orderID int64) error {
	rows, err := h.tx.QueryContext(ctx, "SELECT fulfillment_status FROM order_items WHERE order_id = ?", orderID)
	if err != nil {
		return err
	}
	var statuses []string
	for rows.Next() {
		var s string
		rows.Scan(&s)
		statuses = append(statuses, s)
	}
	rows.Close()
	if len(statuses) == 0 {
		return nil
	}
	finished, started := true, false
	for _, s := range statuses {
		if s != "DONE" && s != "REFUNDED" && s != "CANCELLED" {
			finished = false
		}
		if s == "PROCESSING" || s == "DONE" {
			started = true
		}
	}
	switch {
	case finished:
		_, err = h.transition(ctx, orderID, "COMPLETED", nil)
	case started:
		_, err = h.transition(ctx, orderID, "FULFILLING", nil)
	}
	return err
}

// 物流狀態：同一個事件只記一次（provider_event_id 唯一）；只有比較新、而且不倒退的狀態才更新包裹
var shipmentRank = map[string]int{"REQUESTED": 0, "PICKED_UP": 1, "IN_TRANSIT": 2, "DELIVERED": 3, "FAILED": 3}

func (h *handlers) shipmentStatus(ctx context.Context, p eventPayload) error {
	var id int64
	var status string
	var lastEvent sql.NullTime
	var withdrawalID, orderID sql.NullInt64
	err := h.tx.QueryRowContext(ctx, "SELECT id, status, last_event_at, withdrawal_id, order_id FROM shipments WHERE id = ? FOR UPDATE", p.ShipmentID).
		Scan(&id, &status, &lastEvent, &withdrawalID, &orderID)
	if err == sql.ErrNoRows {
		return fmt.Errorf("shipment %d 不存在", p.ShipmentID)
	}
	if err != nil {
		return err
	}
	occurred, err := time.Parse(time.RFC3339Nano, p.OccurredAt)
	if err != nil {
		return err
	}
	occurred = occurred.UTC()
	n, err := execAffected(ctx, h.tx, "INSERT IGNORE INTO shipment_events (shipment_id, status, occurred_at, provider_event_id, created_at) VALUES (?, ?, ?, ?, ?)",
		id, p.Status, occurred.Truncate(time.Second), p.ProviderEventID, now())
	if err != nil {
		return err
	}
	if n == 0 {
		h.log.Debug("shipment event duplicate, ignored", "shipment_id", id, "status", p.Status, "provider_event_id", p.ProviderEventID)
		return nil
	}
	isNewer := !lastEvent.Valid || occurred.After(lastEvent.Time)
	if !(isNewer && shipmentRank[p.Status] >= shipmentRank[status]) {
		h.log.Info("shipment status out of order, recorded but not applied", "shipment_id", id, "current", status, "incoming", p.Status, "occurred_at", p.OccurredAt)
		return nil
	}
	h.log.Debug("shipment → "+p.Status, "shipment_id", id, "from", status)
	set, args := "status = ?, last_event_at = ?, updated_at = ?", []any{p.Status, occurred.Truncate(time.Second), now()}
	if p.TrackingNo != "" {
		set += ", tracking_no = ?"
		args = append(args, p.TrackingNo)
	}
	if _, err := h.tx.ExecContext(ctx, "UPDATE shipments SET "+set+" WHERE id = ?", append(args, id)...); err != nil {
		return err
	}
	if p.Status == "DELIVERED" {
		if withdrawalID.Valid {
			if _, err := h.tx.ExecContext(ctx, "UPDATE withdrawals SET status = 'DONE', updated_at = ? WHERE id = ?", now(), withdrawalID.Int64); err != nil {
				return err
			}
		}
		if orderID.Valid {
			h.stages.add(orderID.Int64, "shipment_delivered")
			if err := h.markItemsDelivered(ctx, id); err != nil {
				return err
			}
			return h.refreshProgress(ctx, orderID.Int64)
		}
	} else if withdrawalID.Valid {
		_, err := h.tx.ExecContext(ctx, "UPDATE withdrawals SET status = 'SHIPPING', updated_at = ? WHERE id = ? AND status = 'REQUESTED'", now(), withdrawalID.Int64)
		return err
	}
	return nil
}

// 某個明細的所有包裹都送達 → 明細完成
func (h *handlers) markItemsDelivered(ctx context.Context, shipmentID int64) error {
	rows, err := h.tx.QueryContext(ctx, "SELECT order_item_id FROM shipment_items WHERE shipment_id = ? AND order_item_id IS NOT NULL", shipmentID)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, itemID := range ids {
		var pending int
		if err := h.tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
			WHERE si.order_item_id = ? AND s.status != 'DELIVERED'`, itemID).Scan(&pending); err != nil {
			return err
		}
		if pending == 0 {
			if _, err := h.tx.ExecContext(ctx, "UPDATE order_items SET fulfillment_status = 'DONE', updated_at = ? WHERE id = ? AND fulfillment_status = 'PROCESSING'", now(), itemID); err != nil {
				return err
			}
		}
	}
	return nil
}
