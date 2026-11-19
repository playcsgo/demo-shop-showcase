<?php

namespace App\Console\Commands;

use App\Domain\Reconciliation\PaymentReconciler;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

class ReconcilePayments extends Command
{
    protected $signature = 'payments:reconcile';

    protected $description = '對 PENDING_PAYMENT 超過時限的訂單發起付款狀態查詢';

    public function handle(PaymentReconciler $reconciler): int
    {
        $n = $reconciler->run();
        if ($n > 0) {
            $this->info("requested reconcile for {$n} orders");
            Log::info('reconcile requested for stale PENDING_PAYMENT orders', ['count' => $n]);
        }
        if (($r = $reconciler->redriveAuthorizations()) > 0) {
            $this->info("redrove {$r} stuck authorizations");
            Log::warning('redrove stuck authorizations', ['count' => $r]);
        }

        return self::SUCCESS;
    }
}
