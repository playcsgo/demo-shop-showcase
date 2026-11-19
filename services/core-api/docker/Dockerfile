# core-api：PHP-FPM 8.3（與 fortune 相同版本；連線數實驗需要 FPM 的「一個 worker 一條連線」模型）
FROM php:8.3-fpm-alpine

# swoole：給 Laravel Octane 用（core.api.runtime=octane）；同一個 image 也能跑 FPM，兩種模式可以切換對照
RUN apk add --no-cache icu-libs libzip fcgi libstdc++ \
 && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS icu-dev libzip-dev linux-headers \
 && docker-php-ext-install pdo_mysql bcmath intl zip pcntl opcache \
 && pecl install redis \
 && pecl install -D 'enable-sockets="no" enable-openssl="no" enable-mysqlnd="no" enable-swoole-curl="no" enable-cares="no" enable-brotli="no" enable-swoole-pgsql="no" enable-swoole-sqlite="no"' swoole-5.1.6 \
 && docker-php-ext-enable redis swoole \
 && apk del .build-deps

# Datadog APM（ddtrace 擴充）：預設關閉，用 compose.datadog.yaml 啟動時才打開（DD_TRACE_ENABLED）
ARG DD_TRACE_PHP_VERSION=1.26.0
RUN curl -fsSLo /tmp/datadog-setup.php https://github.com/DataDog/dd-trace-php/releases/download/${DD_TRACE_PHP_VERSION}/datadog-setup.php \
 && php /tmp/datadog-setup.php --php-bin=all \
 && rm /tmp/datadog-setup.php
ENV DD_TRACE_ENABLED=false

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY fpm-pool.conf /usr/local/etc/php-fpm.d/zz-pool.conf

WORKDIR /var/www/html
