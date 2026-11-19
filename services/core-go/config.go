package main

import (
	"os"
	"strconv"
	"strings"
)

// 設定都讀 core-api 本來就有的環境變數（K8s 的 core-env、compose 的 core-env），不另外定義一套
type config struct {
	service string // SERVICE_NAME：log 的 service 欄位（core-api／core-relay／core-worker）

	dbDSN     string
	dbMaxOpen int // 每個程序最多幾條資料庫連線：API 預設等於 FPM_MAX_CHILDREN，和 PHP-FPM 每個 Pod 的連線數一樣；worker 等於同時處理數

	workerConcurrency int // WORKER_CONCURRENCY：worker 一批訊息同時處理幾則（一批最多 10 則，預設 10）

	redisAddr string
	jwtDir    string // jwt-private.pem、jwt-public.pem（和 PHP 讀同一個資料夾）
	bffKey    string // BFF_SERVICE_KEY：service-token 用

	appURL   string // 商品圖片網址的前綴（AWS_URL 沒設時是 APP_URL/media）
	assetURL string

	awsRegion   string
	awsEndpoint string
	awsBucket   string
	sqsPrefix   string

	statsdHost string // DD_AGENT_HOST：沒設就不送指標
	statsdEnv  string

	timeScale float64
	logLevel  string
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(env(k, "")); err == nil {
		return n
	}
	return def
}

func loadConfig() config {
	scale, _ := strconv.ParseFloat(env("TIME_SCALE", "1"), 64)
	if scale < 1 {
		scale = 1
	}
	service := env("SERVICE_NAME", "core")
	workerConcurrency := envInt("WORKER_CONCURRENCY", 10)
	if workerConcurrency < 1 {
		workerConcurrency = 1
	}
	maxOpen := envInt("DB_MAX_OPEN", 0)
	if maxOpen <= 0 {
		maxOpen = 2 // relay：PHP 也是一個程序一條連線（加上 inbox 的交易）
		switch service {
		case "core-api":
			maxOpen = envInt("FPM_MAX_CHILDREN", 10)
		case "core-worker":
			maxOpen = workerConcurrency // 每則訊息一個交易：少於同時處理數，多出來的只能排隊等連線
		}
	}
	appURL := strings.TrimRight(env("APP_URL", "http://localhost"), "/")
	assetURL := env("AWS_URL", appURL+"/media")
	logger = newLogger(service, env("LOG_LEVEL", "debug"))
	return config{
		service: service,
		// time_zone：Laravel 寫入的時間都是 UTC 字串；連線的時區也固定 UTC，NOW() 和 Go 寫入的時間才一致
		dbDSN: env("DB_USERNAME", "demo") + ":" + env("DB_PASSWORD", "") + "@tcp(" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306") + ")/" +
			env("DB_DATABASE", "demo") + "?parseTime=true&loc=UTC&time_zone=%27%2B00%3A00%27&interpolateParams=true&charset=utf8mb4&collation=utf8mb4_unicode_ci",
		dbMaxOpen: maxOpen,

		workerConcurrency: workerConcurrency,
		redisAddr:         env("REDIS_HOST", "127.0.0.1") + ":" + env("REDIS_PORT", "6379"),
		jwtDir:            env("JWT_KEYS_DIR", "/var/www/html/storage/app/keys"),
		bffKey:            env("BFF_SERVICE_KEY", ""),
		appURL:            appURL,
		assetURL:          strings.TrimRight(assetURL, "/"),
		awsRegion:         env("AWS_DEFAULT_REGION", "ap-northeast-1"),
		awsEndpoint:       env("AWS_ENDPOINT", ""),
		awsBucket:         env("AWS_BUCKET", "demo-product-images"),
		sqsPrefix:         strings.TrimRight(env("SQS_PREFIX", ""), "/"),
		statsdHost:        env("DD_AGENT_HOST", ""),
		statsdEnv:         env("DD_ENV", ""),
		timeScale:         scale,
		logLevel:          env("LOG_LEVEL", "debug"),
	}
}

// 和 config/shop.php 一樣的時間壓縮：整數秒、至少 1 秒
func (c config) scaled(seconds int) int {
	n := int(float64(seconds)/c.timeScale + 0.5)
	if n < 1 {
		return 1
	}
	return n
}
