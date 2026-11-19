package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// 消費 integration-events（和 PHP 的 events:consume 相同）：一批同時處理（WORKER_CONCURRENCY），成功的一次刪掉；
// 失敗不刪 → 可見性逾時後 SQS 重送 → 失敗 5 次進 DLQ。同一個 event_id 由 inbox 保證只處理一次
func runWorker(ctx context.Context, cfg config) error {
	db, err := openDB(cfg)
	if err != nil {
		return err
	}
	client, err := newSQS(ctx, cfg)
	if err != nil {
		return err
	}
	initStatsd(cfg)
	w := &worker{db: db, cfg: cfg}
	queueURL := aws.String(cfg.sqsPrefix + "/integration-events")
	logger.Info("core-go worker started")
	for ctx.Err() == nil {
		out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl: queueURL, MaxNumberOfMessages: 10, WaitTimeSeconds: 10,
			MessageSystemAttributeNames: []types.MessageSystemAttributeName{types.MessageSystemAttributeNameApproximateReceiveCount},
		})
		if err != nil {
			if ctx.Err() == nil {
				logger.Warn("receive failed", "error", err.Error())
				time.Sleep(time.Second)
			}
			continue
		}
		done := handleBatch(out.Messages, cfg.workerConcurrency, func(m types.Message) bool { return w.handle(ctx, m) })
		if failed := deleteBatch(ctx, client, queueURL, done); failed > 0 {
			logger.Warn("delete failed, SQS will redeliver (inbox skips the duplicate)", "count", failed)
		}
	}
	return nil
}

// 一批訊息同時處理，同時最多 limit 則；回傳成功的（要刪的）。
// 原本一則一則做：每個 Pod 一次只有一個交易在跑，CPU 幾乎沒用，佇列卻消化不及。
// 順序本來就不保證（8 個 Pod 同時在收），同一筆訂單的事件靠交易裡的鎖和 inbox 保證正確
func handleBatch(msgs []types.Message, limit int, handle func(types.Message) bool) []types.Message {
	ok := make([]bool, len(msgs))
	sem := make(chan struct{}, max(limit, 1))
	var wg sync.WaitGroup
	for i, m := range msgs {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			ok[i] = handle(m)
		}()
	}
	wg.Wait()
	done := make([]types.Message, 0, len(msgs))
	for i, m := range msgs {
		if ok[i] {
			done = append(done, m)
		}
	}
	return done
}

type batchDeleter interface {
	DeleteMessageBatch(ctx context.Context, in *sqs.DeleteMessageBatchInput, optFns ...func(*sqs.Options)) (*sqs.DeleteMessageBatchOutput, error)
}

// 成功的一次刪掉（原本每則一個 DeleteMessage，每次都是一趟 SQS 來回）；回傳沒刪掉的則數
func deleteBatch(ctx context.Context, client batchDeleter, queueURL *string, msgs []types.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	entries := make([]types.DeleteMessageBatchRequestEntry, len(msgs))
	for i, m := range msgs {
		entries[i] = types.DeleteMessageBatchRequestEntry{Id: aws.String(strconv.Itoa(i)), ReceiptHandle: m.ReceiptHandle}
	}
	out, err := client.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{QueueUrl: queueURL, Entries: entries})
	if err != nil {
		return len(msgs)
	}
	return len(out.Failed)
}

// 處理一則：成功（含 inbox 判斷為重複）回 true，要刪；失敗回 false，留著等 SQS 重送
func (w *worker) handle(ctx context.Context, m types.Message) bool {
	started := time.Now()
	var env envelope
	json.Unmarshal([]byte(aws.ToString(m.Body)), &env)
	var p struct {
		OrderNo string `json:"order_no"`
	}
	json.Unmarshal(env.Payload, &p)
	log := logger.With("event_id", nonEmpty(env.EventID), "type", nonEmpty(env.Type), "correlation_id", nonEmpty(env.CorrelationID),
		"receive_count", m.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)], "order_no", nonEmpty(p.OrderNo))
	handled, err := w.route(ctx, log, env)
	if err != nil {
		log.Error(fmt.Sprintf("event %s failed, SQS will redeliver", env.Type), "error", err.Error())
		return false
	}
	metrics.handled("core-worker."+env.Type, started)
	if handled {
		log.Info(fmt.Sprintf("event %s handled", env.Type))
	} else {
		log.Info(fmt.Sprintf("event %s duplicate, skipped (inbox)", env.Type))
	}
	return true
}

func nonEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type envelope struct {
	EventID       string          `json:"event_id"`
	Type          string          `json:"type"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

type worker struct {
	db  *sql.DB
	cfg config
}

// Inbox＋EventRouter：記錄已處理和處理本身在同一個交易，處理失敗會一起回滾，下次重送還能再處理
// Go 版只處理直送訂單會遇到的事件；預約、退款的事件回錯誤（留在佇列重送，最後進 DLQ，不會被悄悄吃掉）
func (w *worker) route(ctx context.Context, log ctxLogger, env envelope) (bool, error) {
	handled := false
	var stages stageLog
	err := withTx(ctx, w.db, func(tx *sql.Tx) error {
		stages = nil
		n, err := execAffected(ctx, tx, "INSERT IGNORE INTO inbox_messages (event_id, type, processed_at) VALUES (?, ?, ?)", env.EventID, env.Type, now())
		if err != nil {
			return err
		}
		if n == 0 {
			handled = false
			return nil
		}
		handled = true
		h := &handlers{tx: tx, log: log, cfg: w.cfg, stages: &stages, correlation: env.CorrelationID}
		var p eventPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return err
		}
		switch env.Type {
		case "payment.submitted":
			return h.paymentSubmitted(ctx, p.OrderNo, p.ProviderTxnID)
		case "payment.succeeded":
			return h.paymentSucceeded(ctx, p.OrderNo, p.ProviderTxnID, p.Amount)
		case "payment.failed":
			reason := p.Reason
			if reason == "" {
				reason = "unknown"
			}
			return h.paymentFailed(ctx, p.OrderNo, reason)
		case "shipment.status_changed":
			return h.shipmentStatus(ctx, p)
		}
		return fmt.Errorf("Go 版 core-worker 沒有處理 %s（只支援直送訂單的事件，請切回 PHP 版）", env.Type)
	})
	if err == nil {
		stages.flush(ctx, w.db)
	}
	return handled, err
}

type eventPayload struct {
	OrderNo         string `json:"order_no"`
	ProviderTxnID   string `json:"provider_txn_id"`
	Amount          int    `json:"amount"`
	Reason          string `json:"reason"`
	ShipmentID      int64  `json:"shipment_id"`
	Status          string `json:"status"`
	OccurredAt      string `json:"occurred_at"`
	ProviderEventID string `json:"provider_event_id"`
	TrackingNo      string `json:"tracking_no"`
}
