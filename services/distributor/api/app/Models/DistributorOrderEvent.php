<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** 時間軸：只新增，不修改 */
class DistributorOrderEvent extends Model
{
    public $timestamps = false;

    protected $casts = ['occurred_at' => 'datetime'];

    public static function record(int $batchId, string $type, User|DistributorUser $by, ?string $note = null, ?int $orderId = null): self
    {
        return self::create([
            'batch_id' => $batchId, 'order_id' => $orderId, 'type' => $type, 'note' => $note, 'occurred_at' => now(),
            'actor_type' => $by instanceof User ? 'user' : 'distributor_user', 'actor_id' => $by->id,
        ]);
    }
}
