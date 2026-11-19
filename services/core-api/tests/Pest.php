<?php

use App\Domain\Booking\ClinicGateway;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\Storage;
use Tests\Support\FakeClinicGateway;
use Tests\TestCase;

/*
 * Feature 測試用 DatabaseTruncation（每個測試前清空資料表），不用 RefreshDatabase（包在交易裡）。
 * 原因：併發測試會 fork 出多個程序，各自用自己的連線，只看得到「已提交」的資料。
 */
pest()->extend(TestCase::class)
    ->use(DatabaseTruncation::class)
    ->beforeEach(function () {
        Storage::fake('s3', ['url' => config('filesystems.disks.s3.url')]);   // 種子資料會上傳商品圖片：測試不連 S3（網址設定沿用）
        $this->seed();
        $this->clinic = new FakeClinicGateway;
        app()->instance(ClinicGateway::class, $this->clinic);
    })
    ->in('Feature');

require __DIR__.'/Support/helpers.php';
