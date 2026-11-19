<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Default Filesystem Disk
    |--------------------------------------------------------------------------
    |
    | Here you may specify the default filesystem disk that should be used
    | by the framework. The "local" disk, as well as a variety of cloud
    | based disks are available to your application for file storage.
    |
    */

    'default' => env('FILESYSTEM_DISK', 'local'),

    /*
    |--------------------------------------------------------------------------
    | Filesystem Disks
    |--------------------------------------------------------------------------
    |
    | Below you may configure as many filesystem disks as necessary, and you
    | may even configure multiple disks for the same driver. Examples for
    | most supported storage drivers are configured here for reference.
    |
    | Supported drivers: "local", "ftp", "sftp", "s3"
    |
    */

    'disks' => [

        'local' => [
            'driver' => 'local',
            'root' => storage_path('app/private'),
            'serve' => true,
            'throw' => false,
            'report' => false,
        ],

        'public' => [
            'driver' => 'local',
            'root' => storage_path('app/public'),
            'url' => rtrim(env('APP_URL', 'http://localhost'), '/').'/storage',
            'visibility' => 'public',
            'throw' => false,
            'report' => false,
        ],

        // 商品圖片：存 S3（本機是 LocalStack），資料庫只存路徑（products.image_path）
        // 不能存 Pod 的硬碟：K8s 的 core-api 有 2～8 個 Pod，上傳落在 A、下一個請求落在 B 就找不到；Pod 重建硬碟也清空
        // url：瀏覽器看圖走 core 的 /media/...（MediaController 從 S3 串流），三個環境的 APP_URL 都是瀏覽器連得到的
        //      正式環境改成 S3＋CloudFront 的網址（AWS_URL），圖片不經過 PHP
        's3' => [
            'driver' => 's3',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'region' => env('AWS_DEFAULT_REGION'),
            'bucket' => env('AWS_BUCKET'),
            'url' => env('AWS_URL') ?: rtrim(env('APP_URL', 'http://localhost'), '/').'/media',
            'endpoint' => env('AWS_ENDPOINT'),
            'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),   // LocalStack 要 true（http://localstack:4566/<bucket>/...）
            'throw' => false,
            'report' => false,
        ],

        // 後台上傳的暫存檔（Livewire 先收檔、按儲存才搬到 s3）：一樣放 S3，不然上傳和儲存打到不同 Pod 就找不到暫存檔
        // driver 不能寫 s3：Livewire 看到 s3 會叫瀏覽器直接傳到 S3 的端點（http://localstack:4566 瀏覽器連不到）
        // s3-via-app 就是 s3（AppServiceProvider 註冊），只是讓檔案經過 core 再寫進 S3
        'livewire-tmp' => [
            'driver' => 's3-via-app',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'region' => env('AWS_DEFAULT_REGION'),
            'bucket' => env('AWS_BUCKET'),
            'endpoint' => env('AWS_ENDPOINT'),
            'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
            'throw' => false,
            'report' => false,
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Symbolic Links
    |--------------------------------------------------------------------------
    |
    | Here you may configure the symbolic links that will be created when the
    | `storage:link` Artisan command is executed. The array keys should be
    | the locations of the links and the values should be their targets.
    |
    */

    'links' => [
        public_path('storage') => storage_path('app/public'),
    ],

];
