# core-api 的 Go 版 image：在 PHP 版的 sandbox image 上加 Go 執行檔，image 名稱、port、指令都跟 PHP 版一樣
#   - 壓測路徑（API、relay、worker）換成 Go；入口腳本依指令決定交給誰（docker/go-entrypoint.sh）
#   - artisan（migration、灌資料、不變式檢查）、排程照舊是 PHP：壓測工具、K8s 的 Job 不用改
# scripts/sandbox.sh build 在 .env 的 CORE_RUNTIME=go 時，用這個 image 蓋過 demo-sandbox/core-api:<tag>
ARG BASE_IMAGE=demo-sandbox/core-api:latest

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /core-go .

FROM ${BASE_IMAGE}
COPY --from=build /core-go /usr/local/bin/core-go
# 原本的入口（PHP 的 config／route cache）改名保留，入口換成分流的腳本
RUN mv docker/sandbox-entrypoint.sh docker/sandbox-entrypoint.php.sh
COPY --chmod=755 docker/go-entrypoint.sh docker/sandbox-entrypoint.sh
# 壓測工具、sandbox UI 讀這個判斷執行方式
ENV CORE_RUNTIME=go
