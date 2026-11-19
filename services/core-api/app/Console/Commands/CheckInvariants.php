<?php

namespace App\Console\Commands;

use App\Domain\Reconciliation\InvariantChecker;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/** 對帳報告：所有不變式都成立才回 0（混沌測試最後一步） */
class CheckInvariants extends Command
{
    protected $signature = 'reconcile:check {--json}';

    protected $description = '檢查庫存、寄倉、結算、付款、退款、訂閱的不變式';

    public function handle(InvariantChecker $checker): int
    {
        $results = $checker->check();
        $inFlight = $checker->inFlight();

        if ($this->option('json')) {
            // 每筆違反的訂單附上 correlation_id：sandbox 用它去 Loki 撈這筆的完整時間線
            $orderNos = collect($results)->pluck('order_nos')->flatten()->unique();
            $correlation = DB::table('orders')->whereIn('order_no', $orderNos)->pluck('correlation_id', 'order_no');
            $this->line(json_encode(['checks' => $results, 'in_flight' => $inFlight, 'correlation_ids' => $correlation], JSON_UNESCAPED_UNICODE));
        } else {
            $this->table(['檢查', '結果', '不一致筆數', '範例'], collect($results)->map(fn ($r, $name) => [$name, $r['ok'] ? '✅' : '❌', $r['count'], $r['detail']])->values());
            $this->table(['處理中', '數量'], collect($inFlight)->map(fn ($v, $k) => [$k, $v])->values());
        }

        return collect($results)->every(fn ($r) => $r['ok']) ? self::SUCCESS : self::FAILURE;
    }
}
