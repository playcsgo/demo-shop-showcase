package main

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strings"
	"time"
)

// 和 PHP 的 StatsD／PipelineMetrics／OrderStageMetrics 送一樣的指標（Grafana、Datadog 看板不用改）
//
//	demo.pipeline.handle_ms{step}：每個服務收到 → 做完幾毫秒
//	demo.order.stage_seconds{stage}：訂單從下單到這個階段幾秒
//
// UDP 送失敗不處理：監控壞掉不能拖垮業務。沒設 DD_AGENT_HOST 時什麼都不做
type statsd struct {
	conn net.Conn
	env  string
}

var metrics = &statsd{}

func initStatsd(cfg config) {
	if cfg.statsdHost == "" {
		return
	}
	if c, err := net.Dial("udp", cfg.statsdHost+":8125"); err == nil {
		metrics = &statsd{c, cfg.statsdEnv}
	}
}

func (s *statsd) enabled() bool { return s.conn != nil }

func (s *statsd) distribution(metric string, value float64, tags ...string) {
	if s.conn == nil {
		return
	}
	if s.env != "" {
		tags = append(tags, "env:"+s.env)
	}
	payload := fmt.Sprintf("%s:%s|d", metric, strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", value), "0"), "."))
	if len(tags) > 0 {
		payload += "|#" + strings.Join(tags, ",")
	}
	s.conn.Write([]byte(payload))
}

func (s *statsd) handled(step string, started time.Time) {
	s.distribution("demo.pipeline.handle_ms", float64(time.Since(started).Microseconds())/1000, "step:"+step)
}

// 交易 commit 之後才呼叫（回滾的話這個階段根本沒發生）
func (s *statsd) orderStage(ctx context.Context, db *sql.DB, orderID int64, stage string) {
	if !s.enabled() {
		return
	}
	var created time.Time
	if db.QueryRowContext(ctx, "SELECT created_at FROM orders WHERE id = ?", orderID).Scan(&created) == nil {
		s.distribution("demo.order.stage_seconds", time.Since(created).Seconds(), "stage:"+stage)
	}
}

// 一個交易裡累積的訂單階段，commit 之後一起送
type stageLog []struct {
	orderID int64
	stage   string
}

func (l *stageLog) add(orderID int64, stage string) {
	*l = append(*l, struct {
		orderID int64
		stage   string
	}{orderID, stage})
}

func (l stageLog) flush(ctx context.Context, db *sql.DB) {
	for _, x := range l {
		metrics.orderStage(ctx, db, x.orderID, x.stage)
	}
}
