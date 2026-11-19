<?php

namespace App\Domain\Fulfillment;

use App\Domain\DomainException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * 經 hub 的內部 API 問物流商的預估送達時間（AIC-017）：core 不直接認識外部廠商（§3.1），做法和 HubClinicGateway 一樣。
 * 物流商掛了就是掛了：拋 logistics_unavailable，不給假的預估
 */
class HubLogisticsGateway
{
    /** @return array{shipping_class: string, estimated_seconds: float|int, slow: bool} */
    public function estimate(string $shippingClass): array
    {
        try {
            $res = Http::baseUrl(config('services.hub.url'))
                ->withHeaders(['x-internal-key' => config('services.hub.internal_key'), 'X-Correlation-Id' => request()->header('X-Correlation-Id', '')])
                ->acceptJson()->timeout(config('shop.hub_timeout_seconds'))
                ->get('/internal/logistics/estimate', ['shipping_class' => $shippingClass]);
        } catch (ConnectionException $e) {
            Log::warning('hub unreachable for logistics estimate', ['error' => $e->getMessage()]);
            throw self::unavailable();
        }
        if (! $res->successful()) {
            Log::warning("logistics estimate rejected {$res->status()}", ['status' => $res->status()]);
            throw self::unavailable();
        }

        return $res->json();
    }

    private static function unavailable(): DomainException
    {
        return new DomainException('logistics_unavailable', '物流商暫時無法提供預估', 503);
    }
}
