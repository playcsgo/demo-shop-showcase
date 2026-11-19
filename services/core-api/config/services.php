<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    // BFF 換發顧客 token 用的服務金鑰（正式環境放 Secrets Manager）
    'bff' => [
        'key' => env('BFF_SERVICE_KEY', ''),
    ],

    // AI 客服（support）呼叫 /api/v1/internal/support/* 用的金鑰；和 BFF 的分開，外洩時可以單獨換（AIC-013）
    'support' => [
        'key' => env('SUPPORT_SERVICE_KEY', ''),
    ],

    // hub 的內部 API（醫院保留時段：同步）
    'hub' => [
        'url' => env('HUB_URL', 'http://hub:3000'),
        'internal_key' => env('INTERNAL_API_KEY', 'local-internal-key'),
    ],

    // 外部廠商模擬器（只有 demo「清空所有資料」會呼叫：清掉它的設定和事件紀錄）
    'partners' => [
        'url' => env('PARTNERS_URL', 'http://partners:4000'),
    ],

    // DogStatsD：沒設 DD_AGENT_HOST（沒開 Datadog）時不送
    'datadog' => [
        'agent_host' => env('DD_AGENT_HOST'),
        'env' => env('DD_ENV'),
    ],

];
