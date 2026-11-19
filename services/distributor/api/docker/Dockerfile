# 經銷商 API：PHP-FPM 8.3。只需要 MySQL，所以比商店的 core-api 少了 redis 和 Datadog
FROM php:8.3-fpm-alpine

RUN apk add --no-cache icu-libs libzip fcgi \
 && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS icu-dev libzip-dev linux-headers \
 && docker-php-ext-install pdo_mysql bcmath intl zip pcntl opcache \
 && apk del .build-deps

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY fpm-pool.conf /usr/local/etc/php-fpm.d/zz-pool.conf

WORKDIR /var/www/html
