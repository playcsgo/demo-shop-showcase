package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 預期值由 PHP 的 json_encode 實際算出來（kubectl exec … php -r）
func TestPHPJSONEncodeMatchesPHP(t *testing.T) {
	cases := []struct {
		in   ordered
		want string
	}{
		{ordered{{"utm_source", "a/b 中\"x"}}, "{\"utm_source\":\"a\\/b \\u4e2d\\\"x\"}"},
		{ordered{}, `[]`},
		{ordered{{"utm_source", nil}, {"utm_campaign", "😀"}}, "{\"utm_source\":null,\"utm_campaign\":\"\\ud83d\\ude00\"}"},
	}
	for _, c := range cases {
		if got := phpJSONEncode(c.in); got != c.want {
			t.Errorf("phpJSONEncode(%v) = %s, want %s", c.in, got, c.want)
		}
	}
	sum := sha256.Sum256([]byte(phpJSONEncode(ordered{{"utm_source", "sandbox"}})))
	if got := hex.EncodeToString(sum[:]); got != "b370a08f09dbb5a2e91223f9bdfb28e235343d0a4b1081cd3d3d661ed08f52df" {
		t.Errorf("request_hash = %s，和 PHP 不一樣：同一個 Idempotency-Key 在兩個版本之間重送會被當成不同請求", got)
	}
}

func TestPlanShipments(t *testing.T) {
	pkgs := planShipments([]planLine{
		{key: 1, qty: 2, class: "bulky"},
		{key: 2, qty: 1, class: "standard"},
		{key: 3, qty: 3, class: "litter"},
		{key: 4, qty: 1, class: "standard"},
		{key: 5, qty: 1, class: "service"},
	})
	var classes []string
	for _, p := range pkgs {
		classes = append(classes, p.class)
	}
	if got := strings.Join(classes, ","); got != "standard,litter,bulky,bulky" {
		t.Fatalf("包裹順序 = %s", got)
	}
	if len(pkgs[0].lines) != 2 || pkgs[2].lines[0].qty != 1 {
		t.Errorf("standard 要合併成一包、bulky 每件一包：%+v", pkgs)
	}
	if got := totalFee(pkgs); got != 80+120+1500*2 {
		t.Errorf("運費 = %d", got)
	}
	if pkgs[0].carrier != "home_delivery" || pkgs[2].carrier != "bulky_freight" {
		t.Errorf("物流商不對：%+v", pkgs)
	}
}

func TestAssertCombinable(t *testing.T) {
	direct := cartItem{fulfillment: "direct"}
	cases := []struct {
		items  []cartItem
		reason string
	}{
		{[]cartItem{direct, direct}, ""},
		{[]cartItem{{fulfillment: "subscription"}, direct}, "subscription_must_checkout_alone"},
		{[]cartItem{{fulfillment: "booking"}, direct}, "booking_must_checkout_alone"},
		{[]cartItem{{fulfillment: "warehouse", isLitter: true}, direct}, "litter_warehouse_must_checkout_alone"},
		{[]cartItem{{fulfillment: "warehouse", isLitter: true}}, ""},
		{[]cartItem{{fulfillment: "warehouse"}, direct}, ""},
	}
	for _, c := range cases {
		err := assertCombinable(c.items)
		got := ""
		if de, ok := err.(*domainError); ok {
			got = de.reason
		}
		if got != c.reason {
			t.Errorf("%+v → %q, want %q", c.items, got, c.reason)
		}
	}
}

// 和 Laravel 的驗證錯誤訊息一致（實際打 PHP 版得到的格式）
func TestValidationMessage(t *testing.T) {
	v := &validationError{}
	v.add("email", "The email field must be a valid email address.")
	v.add("password", "The password field is required.")
	if got := v.message(); got != "The email field must be a valid email address. (and 1 more error)" {
		t.Errorf("message = %s", got)
	}
	v.add("qty", "The qty field must be at least 1.")
	if got := v.message(); !strings.HasSuffix(got, "(and 2 more errors)") {
		t.Errorf("message = %s", got)
	}
}

func TestOrderNoFormat(t *testing.T) {
	re := regexp.MustCompile(`^A\d{6}[A-Z0-9]{7}$`)
	for range 50 {
		if no := newOrderNo(); !re.MatchString(no) {
			t.Fatalf("訂單編號格式不對：%s", no)
		}
	}
}

func TestBps(t *testing.T) {
	if got := bps(999, 1500); got != 149 { // 149.85 → 無條件捨去
		t.Errorf("bps = %d", got)
	}
}

func TestJWTRoundTrip(t *testing.T) {
	dir := t.TempDir()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	privDER, _ := x509.MarshalPKCS8PrivateKey(key)
	pubDER, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	os.WriteFile(filepath.Join(dir, "jwt-private.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER}), 0o600)
	os.WriteFile(filepath.Join(dir, "jwt-public.pem"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}), 0o600)
	s, err := loadJWT(dir)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := s.issueForCustomer(42)
	if err != nil {
		t.Fatal(err)
	}
	claims := s.verify(tok.AccessToken)
	if claims == nil || claims["sub"] != "42" || claims["scope"] != "customer" || tok.ExpiresIn != 900 {
		t.Fatalf("claims = %v", claims)
	}
	if s.verify(tok.AccessToken+"x") != nil {
		t.Error("改過的 token 不能通過驗證")
	}
	keys := s.jwks()["keys"].([]map[string]string)
	if keys[0]["kid"] != jwtKID || keys[0]["e"] != "AQAB" {
		t.Errorf("jwks = %v", keys)
	}
}

// log 的欄位順序和 PHP 的 FlatJsonFormatter 一樣：ts、level、service、msg，之後是其他欄位
func TestLogFormat(t *testing.T) {
	var buf bytes.Buffer
	l := newLogger("core-api", "info")
	l.w = &buf
	l.With("correlation_id", "c-1").Info("order placed", "order_no", "A1", "total", 180, "skip", nil)
	l.Debug("不會出現")
	line := strings.TrimSpace(buf.String())
	if !regexp.MustCompile(`^\{"ts":"[^"]+\+00:00","level":"info","service":"core-api","msg":"order placed","correlation_id":"c-1","order_no":"A1","total":180\}$`).MatchString(line) {
		t.Fatalf("log = %s", line)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatal(err)
	}
}
