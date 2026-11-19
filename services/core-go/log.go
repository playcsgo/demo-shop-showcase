package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// 一行一個 JSON，欄位和 PHP 的 FlatJsonFormatter 一樣：ts、level、service、msg，其他欄位放最外層
// 壓測工具用 Loki 找 core-api 的 `order placed`、core-worker 的 `payment succeeded`，靠的就是這個格式
var logger = newLogger("core", "debug")

var levelRank = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

type Logger struct {
	mu      sync.Mutex
	w       io.Writer
	service string
	min     int
}

func newLogger(service, level string) *Logger {
	min, ok := levelRank[level]
	if !ok {
		min = 0
	}
	return &Logger{w: os.Stderr, service: service, min: min}
}

// Fields：有順序的欄位（key, value, key, value…），寫出來的順序和傳進來的一樣
type Fields []any

func (l *Logger) log(level, msg string, ctx Fields, kv Fields) {
	if levelRank[level] < l.min {
		return
	}
	var b bytes.Buffer
	b.WriteString(`{"ts":`)
	writeJSON(&b, time.Now().UTC().Format("2006-01-02T15:04:05.000-07:00"))
	b.WriteString(`,"level":`)
	writeJSON(&b, level)
	b.WriteString(`,"service":`)
	writeJSON(&b, l.service)
	b.WriteString(`,"msg":`)
	writeJSON(&b, msg)
	for _, fs := range []Fields{ctx, kv} {
		for i := 0; i+1 < len(fs); i += 2 {
			if fs[i+1] == nil {
				continue
			}
			b.WriteByte(',')
			writeJSON(&b, fs[i])
			b.WriteByte(':')
			writeJSON(&b, fs[i+1])
		}
	}
	b.WriteString("}\n")
	l.mu.Lock()
	l.w.Write(b.Bytes())
	l.mu.Unlock()
}

func writeJSON(b *bytes.Buffer, v any) {
	enc := json.NewEncoder(b)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	b.Truncate(b.Len() - 1) // Encode 會多一個換行
}

func (l *Logger) Debug(msg string, kv ...any) { l.log("debug", msg, nil, kv) }
func (l *Logger) Info(msg string, kv ...any)  { l.log("info", msg, nil, kv) }
func (l *Logger) Warn(msg string, kv ...any)  { l.log("warn", msg, nil, kv) }
func (l *Logger) Error(msg string, kv ...any) { l.log("error", msg, nil, kv) }

// 帶著固定欄位的 logger（一個請求、一則訊息一組 correlation_id）
type ctxLogger struct {
	l   *Logger
	ctx Fields
}

func (l *Logger) With(ctx ...any) ctxLogger { return ctxLogger{l, ctx} }

func (c ctxLogger) Debug(msg string, kv ...any) { c.l.log("debug", msg, c.ctx, kv) }
func (c ctxLogger) Info(msg string, kv ...any)  { c.l.log("info", msg, c.ctx, kv) }
func (c ctxLogger) Warn(msg string, kv ...any)  { c.l.log("warn", msg, c.ctx, kv) }
func (c ctxLogger) Error(msg string, kv ...any) { c.l.log("error", msg, c.ctx, kv) }
