<?php

use App\Domain\Messaging\InMemoryQueueClient;
use App\Domain\Messaging\QueueClient;
use App\Domain\Ops\DemoReset;
use App\Filament\Pages\Dashboard;
use App\Models\Order;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Redis;
use Livewire\Livewire;

// demo「清空所有資料」：資料庫重建＋種子、SQS、Redis、partners 全部清空，容器不動

it('demo:reset：訂單清空、佇列清空、帳號回到種子資料、partners 重設、Redis 清空', function () {
    paidOrder([['DCS-DCAN-BEEF-165', 1]]);
    $queue = new InMemoryQueueClient;
    $queue->push('integration-events', ['event_id' => 'x']);
    $queue->push('logistics-commands-dlq', ['event_id' => 'y']);
    app()->instance(QueueClient::class, $queue);
    Http::fake();
    $redis = Mockery::mock();
    $redis->shouldReceive('flushall')->once();
    Redis::shouldReceive('connection')->andReturn($redis);   // 測試不能真的清掉本機的 Redis

    $this->artisan('demo:reset')->assertSuccessful();

    expect(Order::count())->toBe(0)
        ->and($queue->depth('integration-events'))->toBe(0)
        ->and($queue->depth('logistics-commands-dlq'))->toBe(0)
        ->and(Hash::check('0204', User::where('email', 'admin@example.test')->value('password')))->toBeTrue()
        ->and(Cache::has(DemoReset::PAUSE_KEY))->toBeFalse();
    Http::assertSent(fn ($req) => str_ends_with($req->url(), '/admin/reset'));
});

it('主控台的清空按鈕：只有 admin 看得到，按下去在背景執行 demo:reset', function () {
    Process::fake();

    $this->actingAs(User::where('email', 'finance@example.test')->firstOrFail());
    Livewire::test(Dashboard::class)->assertActionHidden('resetDemo');

    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    Livewire::test(Dashboard::class)->assertActionVisible('resetDemo')->callAction('resetDemo');

    Process::assertRan(fn ($process) => str_contains($process->command, 'php artisan demo:reset'));
});

it('正式環境不能清空', function () {
    app()->detectEnvironment(fn () => 'production');

    $this->artisan('demo:reset')->assertFailed();
});
