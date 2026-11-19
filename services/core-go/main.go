// core-go：core-api 壓測路徑的 Go 版（和 PHP 版共用同一個資料庫、SQS、JWT 金鑰）
//
//	core-go api      顧客 API：FastCGI（nginx 轉過來，和 PHP-FPM 同一個位置），或 --http 直接開 HTTP（本機測試）
//	core-go relay    outbox → SQS（對應 php artisan outbox:relay）
//	core-go worker   消費 integration-events（對應 php artisan events:consume）
//
// 只做壓測會走到的部分（見 tasks/core_go/specs/core-api-go.md）：只買直送商品；預約、寄倉、訂閱、後台、排程、維運指令照舊用 PHP。
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "用法：core-go api [--http :8080]｜relay｜worker")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	cfg := loadConfig()
	var err error
	switch os.Args[1] {
	case "api":
		err = runAPI(ctx, cfg, os.Args[2:])
	case "relay":
		err = runRelay(ctx, cfg)
	case "worker":
		err = runWorker(ctx, cfg)
	default:
		err = fmt.Errorf("不認識的指令：%s", os.Args[1])
	}
	if err != nil {
		logger.Error(err.Error())
		os.Exit(1)
	}
}
