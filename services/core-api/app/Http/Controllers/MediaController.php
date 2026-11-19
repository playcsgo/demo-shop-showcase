<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * 商品圖片：GET /media/products/xxx.png → 從 S3 串流給瀏覽器
 * 本機的 S3 是 LocalStack（叢集／容器內的網址），瀏覽器連不到；經過 core 轉一手，三個環境都用 APP_URL 就看得到
 * 正式環境改成 S3＋CloudFront（AWS_URL 指向 CDN），圖片不經過 PHP，這個路由就用不到
 */
class MediaController extends Controller
{
    public function show(string $path): StreamedResponse
    {
        // 只開放商品圖片的資料夾：bucket 裡的其他東西（上傳暫存檔）不對外
        abort_unless(str_starts_with($path, 'products/') && ! str_contains($path, '..'), 404);

        $disk = Storage::disk('s3');
        abort_unless($disk->exists($path), 404);

        return $disk->response($path, null, [
            'Cache-Control' => 'public, max-age=86400',   // 檔名每次上傳都不同（hash），可以放心快取
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; sandbox",   // 萬一是 SVG 也不能跑 script
        ]);
    }
}
