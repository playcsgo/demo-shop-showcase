<?php

namespace App\Domain\Messaging;

use Illuminate\Support\Facades\DB;

/**
 * Inbox（§5.8）：同一個 event_id 只處理一次。
 * 「記錄已處理」和「處理本身」在同一個交易：處理失敗會一起回滾，下次重送還能再處理。
 */
class Inbox
{
    /** @return bool true＝這次有處理；false＝之前處理過，略過 */
    public function handleOnce(string $eventId, string $type, callable $handler): bool
    {
        return DB::transaction(function () use ($eventId, $type, $handler) {
            $inserted = DB::table('inbox_messages')->insertOrIgnore([
                'event_id' => $eventId, 'type' => $type, 'processed_at' => now(),
            ]);

            if ($inserted === 0) {
                return false;
            }

            $handler();

            return true;
        });
    }
}
