<?php

namespace App\Providers;

use App\Domain\Auth\JwtService;
use App\Domain\Booking\ClinicGateway;
use App\Domain\Booking\HubClinicGateway;
use App\Domain\Messaging\EventRouter;
use App\Domain\Messaging\OutboxRelay;
use App\Domain\Messaging\QueueClient;
use App\Domain\Messaging\SqsQueueClient;
use App\Domain\Observability\StatsD;
use App\Models\Customer;
use DDTrace\SpanData;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(ClinicGateway::class, HubClinicGateway::class);
        $this->app->singleton(StatsD::class, fn () => new StatsD(config('services.datadog.agent_host'), env: config('services.datadog.env')));
        $this->app->singleton(QueueClient::class, fn () => new SqsQueueClient(config('messaging.sqs')));
    }

    public function boot(): void
    {
        // API 回應不額外包一層 {"data": ...}（列表自己決定要不要包）
        JsonResource::withoutWrapping();

        // 登入限流：依「帳號＋IP」，防暴力破解，但不會因為很多人共用同一個 IP（公司、NAT）就全部被擋
        RateLimiter::for('login', fn (Request $r) => Limit::perMinute(10)->by(strtolower((string) $r->input('email')).'|'.$r->ip()));

        // 顧客驗證：Authorization: Bearer <JWT>（由 BFF 帶入）→ 驗章 → Auth::user() 就是該顧客（§8.3）
        Auth::viaRequest('jwt', function (Request $request) {
            $claims = ($token = $request->bearerToken()) ? app(JwtService::class)->verify($token) : null;

            return $claims && $claims->scope === 'customer' ? Customer::find($claims->sub) : null;
        });

        // 後台上傳的暫存檔放 S3（config/filesystems.php 的 livewire-tmp）：多個 Pod 共用，上傳和儲存打到不同 Pod 也找得到
        // 就是 s3；換個名字，Livewire 才不會叫瀏覽器直接傳到 S3
        Storage::extend('s3-via-app', fn ($app, array $config) => Storage::createS3Driver($config));
        config(['livewire.temporary_file_upload.disk' => 'livewire-tmp']);

        $this->traceBackgroundWork();
    }

    /**
     * 常駐程序的 APM（只有裝了 ddtrace 且開啟時才生效）：
     * relay 每 200 ms 輪詢一次，沒東西可送的那一輪不保留 trace，不然一分鐘幾千條空 trace 把真正的流量淹沒。
     */
    private function traceBackgroundWork(): void
    {
        if (! function_exists('DDTrace\trace_method')) {
            return;
        }

        \DDTrace\trace_method(OutboxRelay::class, 'relayOnce', function (SpanData $span, array $args, $sent) {
            $span->service = 'core-relay';
            $span->resource = 'outbox.relay';
            $span->meta['outbox.sent'] = (string) $sent;
            if ($sent === 0) {
                \DDTrace\set_priority_sampling(\DD_TRACE_PRIORITY_SAMPLING_USER_REJECT);
            }
        });

        \DDTrace\trace_method(EventRouter::class, 'route', function (SpanData $span, array $args) {
            $span->service = 'core-worker';
            $span->resource = 'event '.($args[0]['type'] ?? '?');
            $span->meta['event.id'] = (string) ($args[0]['event_id'] ?? '');
        });
    }
}
