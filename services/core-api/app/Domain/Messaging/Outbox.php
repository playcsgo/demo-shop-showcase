<?php

namespace App\Domain\Messaging;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Outbox（§5.8）：要送出的事件先寫進 outbox_messages，「和業務資料同一個交易」。
 * 交易成功 → 事件一定會被送出（M5 的發送程序負責）；交易失敗 → 事件也不存在。不會漏、不會多。
 */
class Outbox
{
    public function record(string $type, string $queue, array $payload, string $correlationId, ?string $projectCode = null, ?string $causationId = null): string
    {
        if (DB::transactionLevel() === 0) {
            throw new \LogicException('Outbox 必須在交易內寫入（否則業務資料和事件可能不一致）');
        }

        // 指令改送到對應廠商的佇列（config/messaging.php 的 command_routes）；呼叫端照舊寫 core-commands 就好
        if ($queue === config('messaging.publish_queue')) {
            // 不能寫 config("messaging.command_routes.{$type}")：指令名稱本身有點（payment.requested），會被當成巢狀的鍵
            $queue = config('messaging.command_routes')[$type] ?? $queue;
        }

        $eventId = (string) Str::uuid();
        $envelope = [
            'event_id' => $eventId,
            'type' => $type,
            'version' => 1,
            'occurred_at' => now()->toIso8601ZuluString(),
            'correlation_id' => $correlationId,
            'causation_id' => $causationId,
            'project_code' => $projectCode,
            'payload' => $payload,
        ];

        DB::table('outbox_messages')->insert([
            'event_id' => $eventId,
            'type' => $type,
            'queue' => $queue,
            'payload' => json_encode($envelope, JSON_UNESCAPED_UNICODE),
            'correlation_id' => $correlationId,
            'status' => 'PENDING',
            'available_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return $eventId;
    }
}
