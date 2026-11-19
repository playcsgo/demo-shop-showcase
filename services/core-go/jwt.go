package main

import (
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// 和 PHP 的 JwtService 相同：RS256、同一組金鑰、同一個 kid，BFF 不用知道簽發的是哪一個版本
const (
	jwtKID = "core-2026-10"
	jwtTTL = 900
)

type jwtService struct {
	priv *rsa.PrivateKey
	pub  *rsa.PublicKey
}

func loadJWT(dir string) (*jwtService, error) {
	privPEM, err := os.ReadFile(filepath.Join(dir, "jwt-private.pem"))
	if err != nil {
		return nil, err
	}
	pubPEM, err := os.ReadFile(filepath.Join(dir, "jwt-public.pem"))
	if err != nil {
		return nil, err
	}
	priv, err := jwt.ParseRSAPrivateKeyFromPEM(privPEM)
	if err != nil {
		return nil, err
	}
	pub, err := jwt.ParseRSAPublicKeyFromPEM(pubPEM)
	if err != nil {
		return nil, err
	}
	return &jwtService{priv, pub}, nil
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

func (s *jwtService) issueForCustomer(customerID int64) (tokenResponse, error) {
	n := time.Now().Unix()
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": "core-api", "aud": "core-api", "sub": strconv.FormatInt(customerID, 10),
		"scope": "customer", "iat": n, "exp": n + jwtTTL,
	})
	t.Header["kid"] = jwtKID
	signed, err := t.SignedString(s.priv)
	return tokenResponse{signed, "Bearer", jwtTTL}, err
}

// 驗證失敗回 nil（和 PHP 一樣不區分原因）
func (s *jwtService) verify(token string) jwt.MapClaims {
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) { return s.pub, nil },
		jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer("core-api"), jwt.WithAudience("core-api"), jwt.WithExpirationRequired())
	if err != nil {
		return nil
	}
	return claims
}

func (s *jwtService) jwks() map[string]any {
	b64 := base64.RawURLEncoding.EncodeToString
	return map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": jwtKID,
		"n": b64(s.pub.N.Bytes()), "e": b64(big.NewInt(int64(s.pub.E)).Bytes()),
	}}}
}
