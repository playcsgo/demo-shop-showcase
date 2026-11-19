package main

import (
	"context"
	"database/sql"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// outbox → SQS（和 PHP 的 OutboxRelay 相同的三步，呼叫 SQS 不在交易內）：
//  1. 認領（短交易）：FOR UPDATE SKIP LOCKED 拿一批 PENDING，available_at 往後推（租約）
//  2. 送出（交易外）：SendMessageBatch
//  3. 送成功的標 SENT；失敗的等租約到期自動重送（at-least-once，消費端靠 inbox 去重）
func runRelay(ctx context.Context, cfg config) error {
	db, err := openDB(cfg)
	if err != nil {
		return err
	}
	client, err := newSQS(ctx, cfg)
	if err != nil {
		return err
	}
	initStatsd(cfg)
	logger.Info("core-go relay started")
	lease := time.Duration(cfg.scaled(30)) * time.Second
	for ctx.Err() == nil {
		sent, err := relayOnce(ctx, db, client, cfg.sqsPrefix, lease)
		if err != nil && ctx.Err() == nil {
			logger.Warn("outbox relay failed", "error", err.Error())
		}
		if sent == 0 {
			select {
			case <-ctx.Done():
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	return nil
}

type outboxRow struct {
	id                  int64
	typ, queue, payload string
}

func relayOnce(ctx context.Context, db *sql.DB, client *sqs.Client, prefix string, lease time.Duration) (int, error) {
	started := time.Now()
	var rows []outboxRow
	err := withTx(ctx, db, func(tx *sql.Tx) error {
		rows = rows[:0]
		rs, err := tx.QueryContext(ctx, `SELECT id, type, queue, payload FROM outbox_messages
			WHERE status = 'PENDING' AND available_at <= ? ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`, now())
		if err != nil {
			return err
		}
		for rs.Next() {
			var r outboxRow
			if err := rs.Scan(&r.id, &r.typ, &r.queue, &r.payload); err != nil {
				rs.Close()
				return err
			}
			rows = append(rows, r)
		}
		rs.Close()
		if len(rows) == 0 {
			return nil
		}
		ids := make([]any, 0, len(rows)+2)
		ids = append(ids, now().Add(lease), now())
		for _, r := range rows {
			ids = append(ids, r.id)
		}
		_, err = tx.ExecContext(ctx, "UPDATE outbox_messages SET available_at = ?, attempts = attempts + 1, updated_at = ? WHERE id IN ("+placeholders(len(rows))+")", ids...)
		return err
	})
	if err != nil || len(rows) == 0 {
		return 0, err
	}

	byQueue := map[string][]outboxRow{}
	var order []string
	for _, r := range rows {
		if _, ok := byQueue[r.queue]; !ok {
			order = append(order, r.queue)
		}
		byQueue[r.queue] = append(byQueue[r.queue], r)
	}
	var sentIDs []any
	sentType := map[int64]string{}
	for _, q := range order {
		entries := make([]types.SendMessageBatchRequestEntry, 0, len(byQueue[q]))
		for _, r := range byQueue[q] {
			entries = append(entries, types.SendMessageBatchRequestEntry{Id: aws.String(strconv.FormatInt(r.id, 10)), MessageBody: aws.String(r.payload)})
			sentType[r.id] = r.typ
		}
		out, err := client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{QueueUrl: aws.String(prefix + "/" + q), Entries: entries})
		if err != nil {
			logger.Warn("outbox relay: send failed, will retry after lease", "queue", q, "error", err.Error())
			continue
		}
		for _, ok := range out.Successful {
			id, _ := strconv.ParseInt(*ok.Id, 10, 64)
			sentIDs = append(sentIDs, id)
		}
	}
	if len(sentIDs) == 0 {
		return 0, nil
	}
	args := append([]any{now(), now()}, sentIDs...)
	if _, err := db.ExecContext(ctx, "UPDATE outbox_messages SET status = 'SENT', sent_at = ?, updated_at = ? WHERE id IN ("+placeholders(len(sentIDs))+")", args...); err != nil {
		return 0, err
	}
	for _, id := range sentIDs {
		metrics.handled("core-relay."+sentType[id.(int64)], started)
	}
	logger.Debug("outbox relayed", "sent", len(sentIDs))
	return len(sentIDs), nil
}
