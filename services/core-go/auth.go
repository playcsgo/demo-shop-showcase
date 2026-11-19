package main

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type customer struct {
	id              int64
	name, email     string
	paymentTokenRef sql.NullString
}

func (s *server) findCustomer(r *reqCtx, id int64) (*customer, error) {
	c := &customer{}
	err := s.db.QueryRowContext(r.r.Context(), "SELECT id, name, email, payment_token_ref FROM customers WHERE id = ?", id).
		Scan(&c.id, &c.name, &c.email, &c.paymentTokenRef)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

// Authorization: Bearer <JWT>（BFF 帶入）→ 驗章 → scope 要是 customer → 顧客要存在
func (s *server) authenticate(r *http.Request) (*customer, error) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil, authError{}
	}
	claims := s.jwt.verify(strings.TrimPrefix(h, "Bearer "))
	if claims == nil || claims["scope"] != "customer" {
		return nil, authError{}
	}
	sub, _ := claims["sub"].(string)
	id, err := strconv.ParseInt(sub, 10, 64)
	if err != nil {
		return nil, authError{}
	}
	c := &customer{}
	err = s.db.QueryRowContext(r.Context(), "SELECT id, name, email, payment_token_ref FROM customers WHERE id = ?", id).
		Scan(&c.id, &c.name, &c.email, &c.paymentTokenRef)
	if err == sql.ErrNoRows {
		return nil, authError{}
	}
	return c, err
}

func (s *server) login(r *reqCtx, _ []string) error {
	body, _ := readBody(r.r)
	v := &validationError{}
	email := validString(v, body, "email", true, 0)
	if email != nil {
		if _, err := mail.ParseAddress(*email); err != nil || !strings.Contains(*email, "@") {
			v.add("email", "The email field must be a valid email address.")
		}
	}
	password := validString(v, body, "password", true, 0)
	if v.failed() {
		return v
	}
	// 登入限流：每分鐘 10 次，依「帳號＋IP」（和 PHP 的 RateLimiter::for('login') 相同的規則；鍵另外一組，兩邊不共用次數）
	if s.throttled(r, "login:"+strings.ToLower(*email)+"|"+clientIP(r.r), 10) {
		return errThrottled
	}
	var id int64
	var name, hash string
	err := s.db.QueryRowContext(r.r.Context(), "SELECT id, name, password FROM customers WHERE email = ?", *email).Scan(&id, &name, &hash)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	// PHP 的 bcrypt 是 $2y$，Go 的 bcrypt 認得同一種格式
	if err == sql.ErrNoRows || bcrypt.CompareHashAndPassword([]byte(hash), []byte(*password)) != nil {
		return r.json(401, map[string]any{"error": "invalid_credentials"})
	}
	tok, err := s.jwt.issueForCustomer(id)
	if err != nil {
		return err
	}
	return r.json(200, ordered{{"access_token", tok.AccessToken}, {"token_type", tok.TokenType}, {"expires_in", tok.ExpiresIn},
		{"customer", ordered{{"id", id}, {"name", name}, {"email", *email}}}})
}

func (s *server) throttled(r *reqCtx, key string, perMinute int64) bool {
	k := "core-go:throttle:" + key
	ctx := r.r.Context()
	n, err := s.redis.Incr(ctx, k).Result()
	if err != nil {
		return false // Redis 連不上就不擋（和快取一樣：監控、限流壞掉不能擋住業務）
	}
	if n == 1 {
		s.redis.Expire(ctx, k, time.Minute)
	}
	return n > perMinute
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// 服務對服務：BFF 用共享金鑰替已登入的顧客換新的 JWT
func (s *server) serviceToken(r *reqCtx, _ []string) error {
	key := r.r.Header.Get("X-Service-Key")
	if s.cfg.bffKey == "" || subtle.ConstantTimeCompare([]byte(s.cfg.bffKey), []byte(key)) != 1 {
		return r.json(401, map[string]any{"error": "invalid_service_key"})
	}
	body, _ := readBody(r.r)
	v := &validationError{}
	id := validInt(v, body, "customer_id", true)
	if v.failed() {
		return v
	}
	c, err := s.findCustomer(r, *id)
	if err != nil {
		return err
	}
	if c == nil {
		return errNotFound
	}
	tok, err := s.jwt.issueForCustomer(c.id)
	if err != nil {
		return err
	}
	return r.json(200, tok)
}

func (s *server) me(r *reqCtx, _ []string) error {
	return r.json(200, ordered{{"id", r.customer.id}, {"name", r.customer.name}, {"email", r.customer.email}})
}

// ── Laravel 驗證規則（只做這些 API 用到的） ──

// required|string（max > 0 時加上 max:N）。沒送或驗證失敗回 nil
func validString(v *validationError, body map[string]json.RawMessage, field string, required bool, max int) *string {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		if required {
			v.add(field, "The "+attr(field)+" field is required.")
		}
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		v.add(field, "The "+attr(field)+" field must be a string.")
		return nil
	}
	if required && strings.TrimSpace(s) == "" {
		v.add(field, "The "+attr(field)+" field is required.")
		return nil
	}
	if max > 0 && len([]rune(s)) > max {
		v.add(field, "The "+attr(field)+" field must not be greater than "+strconv.Itoa(max)+" characters.")
		return nil
	}
	return &s
}

// required|integer：Laravel 也接受 "12" 這種數字字串
func validInt(v *validationError, body map[string]json.RawMessage, field string, required bool) *int64 {
	raw, ok := body[field]
	if !ok || string(raw) == "null" {
		if required {
			v.add(field, "The "+attr(field)+" field is required.")
		}
		return nil
	}
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			v.add(field, "The "+attr(field)+" field must be an integer.")
			return nil
		}
		n = json.Number(s)
	}
	i, err := strconv.ParseInt(string(n), 10, 64)
	if err != nil {
		v.add(field, "The "+attr(field)+" field must be an integer.")
		return nil
	}
	return &i
}
