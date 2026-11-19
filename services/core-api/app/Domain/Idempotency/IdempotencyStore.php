<?php

namespace App\Domain\Idempotency;

use App\Domain\DomainException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * API 冪等（§5.8）：客戶端帶 Idempotency-Key，同一個 key 重送 → 回同一個結果，不會建立兩張訂單。
 *
 * 「佔住 key → 執行 → 存下回應」全部在同一個交易：
 *  - 執行成功：訂單和存下的回應一起提交，不會出現「訂單建好了、key 卻不見」
 *  - 執行失敗：一起回滾，key 也釋放，客戶端可以重試
 *  - 同一個 key 同時進來：第二個請求在唯一鍵上等第一個提交，之後讀到已存的回應
 *  - 同一個 key 但請求內容不同：422（客戶端 bug）
 */
class IdempotencyStore
{
    /** @return array{0: array, 1: int, 2: bool} [回應內容, HTTP 狀態碼, 是否為重播] */
    public function run(int $customerId, string $key, string $requestHash, callable $work): array
    {
        try {
            return DB::transaction(function () use ($customerId, $key, $requestHash, $work) {
                $id = DB::table('idempotency_keys')->insertGetId([
                    'key' => $key, 'customer_id' => $customerId, 'request_hash' => $requestHash,
                    'created_at' => now(), 'updated_at' => now(),
                ]);

                [$body, $status] = $work();

                DB::table('idempotency_keys')->where('id', $id)->update([
                    'response_code' => $status, 'response_body' => json_encode($body, JSON_UNESCAPED_UNICODE), 'updated_at' => now(),
                ]);

                return [$body, $status, false];
            });
        } catch (UniqueConstraintViolationException $e) {
            $row = DB::table('idempotency_keys')->where(['customer_id' => $customerId, 'key' => $key])->first();
            if (! $row) {
                throw $e; // 不是 idempotency_keys 的唯一鍵衝突
            }
            if ($row->request_hash !== $requestHash) {
                throw new DomainException('idempotency_key_reused', '同一個 Idempotency-Key 不能用在不同的請求', 422);
            }

            return [json_decode($row->response_body, true), $row->response_code, true];
        }
    }

    public static function requireKey(?string $key): string
    {
        if (! $key || strlen($key) > 80) {
            throw new DomainException('idempotency_key_required', '請帶 Idempotency-Key 標頭（最長 80 字）', Response::HTTP_BAD_REQUEST);
        }

        return $key;
    }
}
