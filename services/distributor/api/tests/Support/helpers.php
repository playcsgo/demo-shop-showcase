<?php

use App\Domain\DomainException;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use App\Models\Product;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** 後台人員（種子資料見 DatabaseSeeder） */
function staff(string $email): User
{
    return User::where('email', $email)->firstOrFail();
}

function product(string $sku): Product
{
    return Product::with('inventory', 'ingredients')->where('sku', $sku)->firstOrFail();
}

/**
 * 真的併發：fork 出 $n 個子程序，各自開新的資料庫連線，在同一個時間點一起執行 $work($i)。
 * 用來證明「兩個人同時搶最後一件」時程式還是對的；單一程序的測試永遠測不出 race condition。
 *
 * @return list<array{ok: bool, error: ?string, value: mixed}>
 */
function concurrently(int $n, callable $work): array
{
    $dir = sys_get_temp_dir().'/concurrency-'.Str::random(8);
    mkdir($dir);
    DB::disconnect();                       // 子程序不能共用父程序的連線（同一條 socket 會互相干擾）
    $startAt = microtime(true) + 0.5;       // 起跑線：全部等到同一個時間點才開始

    $pids = [];
    for ($i = 0; $i < $n; $i++) {
        $pid = pcntl_fork();
        if ($pid === 0) {                   // 子程序
            DB::purge();
            DB::reconnect();
            usleep((int) max(0, ($startAt - microtime(true)) * 1_000_000));
            try {
                $result = ['ok' => true, 'error' => null, 'value' => $work($i)];
            } catch (Throwable $e) {
                $result = ['ok' => false, 'error' => $e instanceof DomainException ? $e->reason : $e->getMessage(), 'value' => null];
            }
            file_put_contents("{$dir}/{$i}.json", json_encode($result));   // 結果寫檔交給父程序
            DB::disconnect();
            posix_kill(posix_getpid(), SIGKILL);   // 直接結束：不要跑到 PHPUnit 的收尾程式
        }
        $pids[] = $pid;
    }

    foreach ($pids as $pid) {
        pcntl_waitpid($pid, $status);
    }
    DB::reconnect();

    $results = [];
    for ($i = 0; $i < $n; $i++) {
        $results[] = json_decode((string) @file_get_contents("{$dir}/{$i}.json"), true) ?? ['ok' => false, 'error' => 'child crashed', 'value' => null];
    }
    array_map('unlink', glob("{$dir}/*"));
    rmdir($dir);

    return $results;
}

function distributorUser(string $email = 'pacific-manager@example.test'): DistributorUser
{
    return DistributorUser::where('email', $email)->firstOrFail();
}

/** D-PACIFIC 的三個 shop：['hk' => id, 'sg' => id, 'mo' => id] */
function pacificShops(): array
{
    $ids = DistributorShop::whereIn('name', ['香港門市', '新加坡門市', '澳門門市'])->pluck('id', 'name');

    return ['hk' => $ids['香港門市'], 'sg' => $ids['新加坡門市'], 'mo' => $ids['澳門門市']];
}

/** 現貨單的請求內容：[shop_id => [product_id => 箱數]] */
function stockInput(array $shops): array
{
    return ['order_type' => 'stock', 'orders' => array_map(fn (int $shopId, array $items) => [
        'shop_id' => $shopId,
        'items' => array_map(fn (int $productId, int $cases) => ['product_id' => $productId, 'qty_cases' => $cases], array_keys($items), $items),
    ], array_keys($shops), $shops)];
}
