package main

import (
	"context"
	"io"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// AWS 用戶端：本機是 LocalStack（AWS_ENDPOINT）；帳密沒設就給假的（LocalStack 不檢查）
func awsConfig(ctx context.Context, cfg config) (aws.Config, error) {
	key, secret := env("AWS_ACCESS_KEY_ID", "test"), env("AWS_SECRET_ACCESS_KEY", "test")
	return awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.awsRegion),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(key, secret, "")))
}

func newSQS(ctx context.Context, cfg config) (*sqs.Client, error) {
	ac, err := awsConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return sqs.NewFromConfig(ac, func(o *sqs.Options) {
		if cfg.awsEndpoint != "" {
			o.BaseEndpoint = aws.String(cfg.awsEndpoint)
		}
	}), nil
}

// 商品圖片：GET /media/products/xxx.png → 從 S3 串流（和 PHP 的 MediaController 相同，只開放 products/）
type mediaStore struct {
	client *s3.Client
	bucket string
}

func newMediaStore(ctx context.Context, cfg config) *mediaStore {
	ac, err := awsConfig(ctx, cfg)
	if err != nil {
		return &mediaStore{}
	}
	return &mediaStore{s3.NewFromConfig(ac, func(o *s3.Options) {
		if cfg.awsEndpoint != "" {
			o.BaseEndpoint = aws.String(cfg.awsEndpoint)
		}
		o.UsePathStyle = env("AWS_USE_PATH_STYLE_ENDPOINT", "false") == "true"
	}), cfg.awsBucket}
}

func (m *mediaStore) serve(w http.ResponseWriter, r *http.Request, path string) {
	if m.client == nil || !strings.HasPrefix(path, "products/") || strings.Contains(path, "..") {
		http.NotFound(w, r)
		return
	}
	obj, err := m.client.GetObject(r.Context(), &s3.GetObjectInput{Bucket: aws.String(m.bucket), Key: aws.String(path)})
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer obj.Body.Close()
	if obj.ContentType != nil {
		w.Header().Set("Content-Type", *obj.ContentType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	io.Copy(w, obj.Body)
}
