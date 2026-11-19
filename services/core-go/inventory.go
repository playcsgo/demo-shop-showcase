package main

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"sort"
	"time"
)

// 和 PHP 的 InventoryService 相同的規則：
//   - 預留：先不上鎖看哪些桶有貨、隨機排順序，一桶一桶 FOR UPDATE SKIP LOCKED（別人在用就跳過）；
//     都忙的話照桶號排隊等。一桶不夠就從下一桶補，一桶一筆預留紀錄
//   - 實扣／釋放：先搶下預留的狀態（HELD → 目標），搶到的才動庫存 → 重複呼叫不會重複扣
func reserveStock(ctx context.Context, tx *sql.Tx, orderID, variantID int64, qty int, expiresAt time.Time) error {
	taken := map[int]int{}
	candidates, err := bucketNos(ctx, tx, "SELECT bucket_no FROM inventory WHERE variant_id = ? AND on_hand > reserved", variantID)
	if err != nil {
		return err
	}
	rand.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })
	remaining, err := takeFrom(ctx, tx, variantID, candidates, qty, taken, true)
	if err != nil {
		return err
	}
	if remaining > 0 {
		all, err := bucketNos(ctx, tx, "SELECT bucket_no FROM inventory WHERE variant_id = ? ORDER BY bucket_no", variantID)
		if err != nil {
			return err
		}
		if remaining, err = takeFrom(ctx, tx, variantID, all, remaining, taken, false); err != nil {
			return err
		}
	}
	if remaining > 0 {
		return domainErr("insufficient_stock", fmt.Sprintf("variant %d 庫存不足", variantID), 409)
	}
	buckets := make([]int, 0, len(taken))
	for b := range taken {
		buckets = append(buckets, b)
	}
	sort.Ints(buckets)
	t := now()
	for _, b := range buckets {
		if _, err := tx.ExecContext(ctx, `INSERT INTO inventory_reservations (order_id, variant_id, bucket_no, qty, status, expires_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'HELD', ?, ?, ?)`, orderID, variantID, b, taken[b], expiresAt, t, t); err != nil {
			return err
		}
	}
	return nil
}

func bucketNos(ctx context.Context, tx *sql.Tx, query string, variantID int64) ([]int, error) {
	rows, err := tx.QueryContext(ctx, query, variantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var b int
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func takeFrom(ctx context.Context, tx *sql.Tx, variantID int64, buckets []int, remaining int, taken map[int]int, skipLocked bool) (int, error) {
	lock := " FOR UPDATE"
	if skipLocked {
		lock += " SKIP LOCKED"
	}
	for _, b := range buckets {
		if remaining == 0 {
			break
		}
		if _, ok := taken[b]; ok {
			continue
		}
		var available int
		err := tx.QueryRowContext(ctx, "SELECT on_hand - reserved FROM inventory WHERE variant_id = ? AND bucket_no = ?"+lock, variantID, b).Scan(&available)
		if err == sql.ErrNoRows || (err == nil && available <= 0) {
			continue
		}
		if err != nil {
			return 0, err
		}
		n := min(available, remaining)
		if _, err := tx.ExecContext(ctx, "UPDATE inventory SET reserved = reserved + ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?", n, variantID, b); err != nil {
			return 0, err
		}
		taken[b] = n
		remaining -= n
	}
	return remaining, nil
}

func commitStock(ctx context.Context, tx *sql.Tx, orderID int64) error {
	return settleStock(ctx, tx, orderID, "COMMITTED", "on_hand = on_hand - ?, reserved = reserved - ?", 2)
}

func releaseStock(ctx context.Context, tx *sql.Tx, orderID int64) error {
	return settleStock(ctx, tx, orderID, "RELEASED", "reserved = reserved - ?", 1)
}

func settleStock(ctx context.Context, tx *sql.Tx, orderID int64, to, set string, binds int) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, variant_id, bucket_no, qty FROM inventory_reservations WHERE order_id = ? AND status = 'HELD'", orderID)
	if err != nil {
		return err
	}
	type held struct {
		id, variantID int64
		bucket, qty   int
	}
	var list []held
	for rows.Next() {
		var h held
		if err := rows.Scan(&h.id, &h.variantID, &h.bucket, &h.qty); err != nil {
			rows.Close()
			return err
		}
		list = append(list, h)
	}
	rows.Close()
	for _, h := range list {
		won, err := execAffected(ctx, tx, "UPDATE inventory_reservations SET status = ?, updated_at = ? WHERE id = ? AND status = 'HELD'", to, now(), h.id)
		if err != nil {
			return err
		}
		if won != 1 {
			continue
		}
		args := []any{h.qty}
		if binds == 2 {
			args = append(args, h.qty)
		}
		args = append(args, h.variantID, h.bucket)
		if _, err := tx.ExecContext(ctx, "UPDATE inventory SET "+set+", updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?", args...); err != nil {
			return err
		}
	}
	return nil
}
