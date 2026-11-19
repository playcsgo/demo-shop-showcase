#!/bin/sh
# core-api 的 Go 版入口：壓測路徑的三個程序換成 Go，其他指令照舊交給 PHP
#   php-fpm                    → core-go api（FastCGI :9000，nginx 照原本的設定轉過來）
#   php artisan outbox:relay   → core-go relay
#   php artisan events:consume → core-go worker
#   其他（artisan migrate、sandbox:data、reconcile:check、schedule:work…）→ 原本的 PHP 入口
set -e
[ "$1" = php-fpm ] && exec core-go api
if [ "$1" = php ] && [ "$2" = artisan ]; then
  case "$3" in
    outbox:relay) exec core-go relay ;;
    events:consume) exec core-go worker ;;
  esac
fi
exec /var/www/html/docker/sandbox-entrypoint.php.sh "$@"
