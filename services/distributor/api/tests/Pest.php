<?php

use Illuminate\Foundation\Testing\DatabaseTruncation;
use Tests\TestCase;

/*
 * Feature 測試：每個測試都有完整的 Laravel app，開始前清空資料表再跑種子資料。
 * 不用 RefreshDatabase：併發測試會開子程序，各自用自己的連線，只看得到已經 commit 的資料
 */
pest()->extend(TestCase::class)
    ->use(DatabaseTruncation::class)
    ->beforeEach(fn () => $this->seed())
    ->in('Feature');

require __DIR__.'/Support/helpers.php';
