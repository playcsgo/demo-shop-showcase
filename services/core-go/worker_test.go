package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func messages(n int) []types.Message {
	out := make([]types.Message, n)
	for i := range out {
		out[i] = types.Message{MessageId: aws.String(fmt.Sprintf("m%d", i)), ReceiptHandle: aws.String(fmt.Sprintf("r%d", i))}
	}
	return out
}

// 一批 10 則、同時上限 4：同時在處理的最多 4 則，而且真的有同時（不是一則一則）
func TestHandleBatchRunsConcurrentlyUpToLimit(t *testing.T) {
	var inFlight, peak atomic.Int32
	handle := func(types.Message) bool {
		n := inFlight.Add(1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
		}
		time.Sleep(20 * time.Millisecond)
		inFlight.Add(-1)
		return true
	}
	done := handleBatch(messages(10), 4, handle)
	if len(done) != 10 {
		t.Fatalf("done = %d, want 10", len(done))
	}
	if got := peak.Load(); got != 4 {
		t.Fatalf("peak concurrency = %d, want 4", got)
	}
}

// 失敗的不放進「要刪的」：留在佇列等 SQS 重送
func TestHandleBatchKeepsOnlySucceeded(t *testing.T) {
	handle := func(m types.Message) bool {
		return aws.ToString(m.MessageId) != "m1" && aws.ToString(m.MessageId) != "m3"
	}
	done := handleBatch(messages(5), 10, handle)
	got := map[string]bool{}
	for _, m := range done {
		got[aws.ToString(m.MessageId)] = true
	}
	if len(done) != 3 || got["m1"] || got["m3"] || !got["m0"] || !got["m2"] || !got["m4"] {
		t.Fatalf("done = %v, want m0 m2 m4", got)
	}
}

type fakeDeleter struct {
	mu     sync.Mutex
	calls  []*sqs.DeleteMessageBatchInput
	failed []types.BatchResultErrorEntry
}

func (f *fakeDeleter) DeleteMessageBatch(_ context.Context, in *sqs.DeleteMessageBatchInput, _ ...func(*sqs.Options)) (*sqs.DeleteMessageBatchOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in)
	return &sqs.DeleteMessageBatchOutput{Failed: f.failed}, nil
}

// 一批成功的訊息只呼叫一次 DeleteMessageBatch，每一則都帶自己的 receipt handle
func TestDeleteBatchSendsOneCall(t *testing.T) {
	f := &fakeDeleter{}
	failed := deleteBatch(context.Background(), f, aws.String("q"), messages(7))
	if len(f.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(f.calls))
	}
	entries := f.calls[0].Entries
	if len(entries) != 7 {
		t.Fatalf("entries = %d, want 7", len(entries))
	}
	for i, e := range entries {
		if aws.ToString(e.ReceiptHandle) != fmt.Sprintf("r%d", i) || aws.ToString(e.Id) == "" {
			t.Fatalf("entry %d = %+v", i, e)
		}
	}
	if failed != 0 {
		t.Fatalf("failed = %d, want 0", failed)
	}
}

// 沒有成功的就不呼叫（SQS 不接受空的批次）
func TestDeleteBatchSkipsEmpty(t *testing.T) {
	f := &fakeDeleter{}
	deleteBatch(context.Background(), f, aws.String("q"), nil)
	if len(f.calls) != 0 {
		t.Fatalf("calls = %d, want 0", len(f.calls))
	}
}

// 批次裡個別刪除失敗：回報幾則（會被重送，inbox 擋重複）
func TestDeleteBatchReportsPartialFailure(t *testing.T) {
	f := &fakeDeleter{failed: []types.BatchResultErrorEntry{{Id: aws.String("0"), Code: aws.String("ReceiptHandleIsInvalid")}}}
	if failed := deleteBatch(context.Background(), f, aws.String("q"), messages(3)); failed != 1 {
		t.Fatalf("failed = %d, want 1", failed)
	}
}

// worker 的連線池預設等於同時處理數；DB_MAX_OPEN 可以蓋過
func TestWorkerPoolFollowsConcurrency(t *testing.T) {
	t.Setenv("SERVICE_NAME", "core-worker")
	t.Setenv("WORKER_CONCURRENCY", "6")
	if c := loadConfig(); c.workerConcurrency != 6 || c.dbMaxOpen != 6 {
		t.Fatalf("concurrency=%d maxOpen=%d, want 6 6", c.workerConcurrency, c.dbMaxOpen)
	}
	t.Setenv("WORKER_CONCURRENCY", "")
	if c := loadConfig(); c.workerConcurrency != 10 || c.dbMaxOpen != 10 {
		t.Fatalf("default concurrency=%d maxOpen=%d, want 10 10", c.workerConcurrency, c.dbMaxOpen)
	}
	t.Setenv("DB_MAX_OPEN", "3")
	if c := loadConfig(); c.dbMaxOpen != 3 {
		t.Fatalf("maxOpen=%d, want 3 (DB_MAX_OPEN)", c.dbMaxOpen)
	}
	t.Setenv("SERVICE_NAME", "core-relay")
	t.Setenv("DB_MAX_OPEN", "")
	if c := loadConfig(); c.dbMaxOpen != 2 {
		t.Fatalf("relay maxOpen=%d, want 2", c.dbMaxOpen)
	}
}
