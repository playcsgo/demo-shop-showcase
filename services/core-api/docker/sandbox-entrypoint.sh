#!/bin/sh
# sandbox 的 core 容器啟動時：用「這一套」的環境變數產生 cache，存在容器自己的檔案系統裡
# （正式環境部署時也是做這幾件事；開發環境不 cache，改程式才會馬上生效）
set -e
php artisan config:cache >/dev/null
php artisan route:cache >/dev/null
php artisan view:cache >/dev/null
php artisan event:cache >/dev/null
exec docker-php-entrypoint "$@"
