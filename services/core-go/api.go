package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"net"
	"net/http"
	"net/http/fcgi"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type server struct {
	cfg      config
	db       *sql.DB
	redis    *redis.Client
	jwt      *jwtService
	inflight atomic.Int64
	media    *mediaStore
}

func runAPI(ctx context.Context, cfg config, args []string) error {
	fs := flag.NewFlagSet("api", flag.ExitOnError)
	httpAddr := fs.String("http", "", "直接開 HTTP（本機測試用）；不給就是 FastCGI")
	fcgiAddr := fs.String("fcgi", ":9000", "FastCGI 位址（nginx 的 fastcgi_pass，和 PHP-FPM 同一個 port）")
	fs.Parse(args)

	db, err := openDB(cfg)
	if err != nil {
		return err
	}
	keys, err := loadJWT(cfg.jwtDir)
	if err != nil {
		return err
	}
	initStatsd(cfg)
	s := &server{cfg: cfg, db: db, jwt: keys,
		redis: redis.NewClient(&redis.Options{Addr: cfg.redisAddr, PoolSize: cfg.dbMaxOpen * 2})}
	s.media = newMediaStore(ctx, cfg)

	addr, serve := *fcgiAddr, func(l net.Listener) error { return fcgi.Serve(l, s) }
	if *httpAddr != "" {
		hs := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
		addr, serve = *httpAddr, hs.Serve
		go func() { <-ctx.Done(); hs.Shutdown(context.Background()) }()
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); l.Close() }()
	logger.Info("core-go api listening", "addr", addr, "fastcgi", *httpAddr == "", "db_max_open", cfg.dbMaxOpen)
	if err := serve(l); err != nil && ctx.Err() == nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// 一個請求的狀態：correlation id、記 log 用的欄位、驗證過的顧客
type reqCtx struct {
	w        http.ResponseWriter
	r        *http.Request
	started  time.Time // nginx 收到請求的時間（X-Request-Start），和 PHP 一樣含排隊的時間
	corr     string
	log      ctxLogger
	customer *customer
	status   int
}

type route struct {
	method, pattern string
	step            string // 指標的 step：core-api.post.checkout
	re              *regexp.Regexp
	auth            bool
	handle          func(*server, *reqCtx, []string) error
}

var routes = []*route{
	{method: "POST", pattern: "/api/v1/auth/login", step: "auth.login", handle: (*server).login},
	{method: "GET", pattern: "/api/v1/catalog", step: "catalog", handle: (*server).catalog},
	{method: "POST", pattern: "/api/v1/auth/service-token", step: "auth.service-token", handle: (*server).serviceToken},
	{method: "GET", pattern: "/api/v1/me", step: "me", auth: true, handle: (*server).me},
	{method: "GET", pattern: "/api/v1/cart", step: "cart", auth: true, handle: (*server).cartShow},
	{method: "PUT", pattern: "/api/v1/cart/items", step: "cart.items", auth: true, handle: (*server).cartPut},
	{method: "DELETE", pattern: `/api/v1/cart/items/(\d+)`, step: "cart.items.itemid", auth: true, handle: (*server).cartRemove},
	{method: "POST", pattern: "/api/v1/checkout", step: "checkout", auth: true, handle: (*server).checkout},
}

func init() {
	for _, rt := range routes {
		rt.re = regexp.MustCompile("^" + rt.pattern + "$")
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/up":
		// Laravel 的健康檢查回 HTML；K8s 探針只看狀態碼
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte("<!DOCTYPE html><html><body>Application up</body></html>"))
		return
	case path == "/fpm-status":
		s.fpmStatus(w)
		return
	case path == "/.well-known/jwks.json":
		w.Header().Set("Cache-Control", "public, max-age=300")
		writeJSONResponse(w, 200, s.jwt.jwks())
		return
	case strings.HasPrefix(path, "/media/"):
		s.media.serve(w, r, strings.TrimPrefix(path, "/media/"))
		return
	}

	s.inflight.Add(1)
	defer s.inflight.Add(-1)
	rc := &reqCtx{w: w, r: r, started: requestStart(r), corr: correlationID(r)}
	rc.log = logger.With("correlation_id", rc.corr)
	w.Header().Set("X-Correlation-Id", rc.corr)

	var matched *route
	var params []string
	for _, rt := range routes {
		if m := rt.re.FindStringSubmatch(path); m != nil && rt.method == r.Method {
			matched, params = rt, m[1:]
			break
		}
	}
	if matched == nil {
		rc.json(404, map[string]any{"error": "not_found"})
		return
	}
	err := func() error {
		if matched.auth {
			c, err := s.authenticate(r)
			if err != nil {
				return err
			}
			rc.customer = c
		}
		return matched.handle(s, rc, params)
	}()
	if err != nil {
		rc.fail(err)
	}
	// 和 PHP 的 RecordHandleTime 相同：只記有對到路由的請求
	metrics.handled("core-api."+strings.ToLower(r.Method)+"."+matched.step, rc.started)
	rc.log.Debug(r.Method+" "+path+" → "+strconv.Itoa(rc.status), "method", r.Method, "path", path, "status", rc.status,
		"ms", time.Since(rc.started).Milliseconds(), "customer_id", customerID(rc.customer))
}

func customerID(c *customer) any {
	if c == nil {
		return nil
	}
	return c.id
}

// X-Request-Start: t=秒.毫秒（nginx 填的）；沒有就用 Go 收到的時間
func requestStart(r *http.Request) time.Time {
	if h := r.Header.Get("X-Request-Start"); strings.HasPrefix(h, "t=") {
		if f, err := strconv.ParseFloat(h[2:], 64); err == nil {
			return time.UnixMicro(int64(f * 1e6))
		}
	}
	return time.Now()
}

func correlationID(r *http.Request) string {
	id := r.Header.Get("X-Correlation-Id")
	if len(id) > 64 {
		id = id[:64]
	}
	if id == "" {
		id = uuid.NewString()
	}
	return id
}

func (rc *reqCtx) json(status int, body any) error {
	rc.status = status
	writeJSONResponse(rc.w, status, body)
	return nil
}

func writeJSONResponse(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(body)
}

// 錯誤的回應格式和 PHP（bootstrap/app.php 的 withExceptions）一樣
func (rc *reqCtx) fail(err error) {
	var de *domainError
	var ve *validationError
	var ae authError
	switch {
	case errors.As(err, &ae):
		rc.json(401, map[string]any{"error": "unauthenticated"})
	case errors.As(err, &de):
		rc.json(de.status, map[string]any{"error": de.reason, "message": de.message})
	case errors.As(err, &ve):
		rc.json(422, map[string]any{"message": ve.message(), "errors": ve.errors})
	case errors.Is(err, errNotFound):
		rc.json(404, map[string]any{"error": "not_found"})
	case errors.Is(err, errThrottled):
		rc.json(429, map[string]any{"message": "Too Many Attempts."})
	default:
		rc.log.Error(err.Error(), "path", rc.r.URL.Path)
		rc.json(500, map[string]any{"message": "Server Error"})
	}
}

var (
	errNotFound  = errors.New("not found")
	errThrottled = errors.New("too many attempts")
)

type authError struct{}

func (authError) Error() string { return "unauthenticated" }

// 壓測工具每 5 秒讀 /fpm-status?json 看「忙／上限／排隊」。Go 沒有 worker 池，用最接近的意思回報：
//
//	active：正在用的資料庫連線（和 FPM 一個 worker 一條連線對應）｜total：連線上限｜queue：進來了但還沒拿到連線的請求
func (s *server) fpmStatus(w http.ResponseWriter) {
	st := s.db.Stats()
	queue := s.inflight.Load() - int64(st.InUse)
	if queue < 0 {
		queue = 0
	}
	writeJSONResponse(w, 200, map[string]any{
		"pool": "core-go", "process manager": "go",
		"active processes": st.InUse, "total processes": st.MaxOpenConnections, "listen queue": queue,
	})
}

// 讀 JSON 請求本文：只記「有出現的欄位」（Laravel 的 validated() 只回有送來的欄位）
func readBody(r *http.Request) (map[string]json.RawMessage, error) {
	body := map[string]json.RawMessage{}
	if r.Body == nil {
		return body, nil
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&body); err != nil && err.Error() != "EOF" {
		return map[string]json.RawMessage{}, nil // 不是 JSON：當作沒有欄位，由驗證規則回 422
	}
	return body, nil
}
