package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"

	"github.com/google/uuid"
)

// 指令依廠商分到各自的佇列（config/messaging.php 的 command_routes）；沒列的照舊送 core-commands
var commandRoutes = map[string]string{
	"payment.requested":           "payment-commands",
	"payment.capture.requested":   "payment-commands",
	"payment.void.requested":      "payment-commands",
	"refund.requested":            "payment-commands",
	"payment.reconcile.requested": "payment-reconcile-commands",
	"shipment.requested":          "logistics-commands",
	"booking.confirm.requested":   "clinic-commands",
	"booking.release.requested":   "clinic-commands",
	"notification.requested":      "line-commands",
}

// 有順序的 JSON 物件：envelope 和 payload 的欄位順序跟 PHP 一樣（hub 不在意順序，但對照兩邊的訊息時好比對）
type kv struct {
	k string
	v any
}

type ordered []kv

func (o ordered) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	for _, x := range o {
		if !first {
			b.WriteByte(',')
		}
		first = false
		writeJSON(&b, x.k)
		b.WriteByte(':')
		writeJSON(&b, x.v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// array_filter($payload, fn ($v) => $v !== null)
func (o ordered) withoutNulls() ordered {
	out := ordered{}
	for _, x := range o {
		if x.v != nil {
			out = append(out, x)
		}
	}
	return out
}

// 和 PHP 的 Outbox::record 一樣：和業務資料同一個交易寫進 outbox_messages，relay 再送到 SQS
func outboxRecord(ctx context.Context, tx *sql.Tx, typ, queue string, payload ordered, correlationID string) (string, error) {
	if queue == "core-commands" {
		if q, ok := commandRoutes[typ]; ok {
			queue = q
		}
	}
	eventID := uuid.NewString()
	t := now()
	envelope, err := json.Marshal(ordered{
		{"event_id", eventID}, {"type", typ}, {"version", 1},
		{"occurred_at", t.Format("2006-01-02T15:04:05Z")},
		{"correlation_id", correlationID}, {"causation_id", nil}, {"project_code", nil},
		{"payload", payload},
	})
	if err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO outbox_messages (event_id, type, queue, payload, correlation_id, status, available_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`, eventID, typ, queue, string(envelope), correlationID, t, t, t)
	return eventID, err
}
