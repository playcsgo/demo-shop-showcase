<?php

namespace App\Domain\Booking;

use App\Domain\DomainException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/** 經 hub 的內部 API 呼叫醫院（core 不直接認識外部廠商，§3.1） */
class HubClinicGateway implements ClinicGateway
{
    public function hold(string $holdKey, string $startAt, string $serviceType): array
    {
        return $this->send(fn ($http) => $http->post('/internal/clinic/holds', [
            'hold_key' => $holdKey, 'start_at' => $startAt, 'service_type' => $serviceType,
        ]));
    }

    private function send(callable $call): array
    {
        $http = Http::baseUrl(config('services.hub.url'))
            // correlation_id 一路帶到廠商：log 串得起來，sandbox 也靠它決定要不要注入故障
            ->withHeaders(['x-internal-key' => config('services.hub.internal_key'), 'X-Correlation-Id' => request()->header('X-Correlation-Id', '')])
            ->acceptJson()->timeout(config('shop.hub_timeout_seconds')); // hub 那邊最多 2 次 × 2.5 秒（時間壓縮時跟著縮）

        try {
            $res = $call($http);
        } catch (ConnectionException $e) {
            Log::warning('hub unreachable for clinic call', ['error' => $e->getMessage()]);
            throw self::unavailable();
        }
        if (! $res->successful()) {
            Log::log($res->status() >= 500 ? 'warning' : 'info', "clinic call rejected {$res->status()}", ['status' => $res->status(), 'body' => $res->json()]);
        }

        return match (true) {
            $res->successful() => $res->json(),
            $res->status() === 409 => throw new DomainException('slot_full', '這個時段剛被訂走，請改選其他時段', 409),
            $res->status() === 422 => throw new DomainException('invalid_slot', '時段不正確，請重新選擇', 422),
            default => throw self::unavailable(),
        };
    }

    private static function unavailable(): DomainException
    {
        return new DomainException('clinic_unavailable', '醫院預約系統暫時無法使用，請稍後再試（其他商品可以照常購買）', 503);
    }
}
