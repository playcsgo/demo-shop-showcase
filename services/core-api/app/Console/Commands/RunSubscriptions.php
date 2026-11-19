<?php

namespace App\Console\Commands;

use App\Domain\Subscriptions\SubscriptionRunner;
use Illuminate\Console\Command;

class RunSubscriptions extends Command
{
    protected $signature = 'subscriptions:run';

    protected $description = '產生到期訂閱的下一期訂單';

    public function handle(SubscriptionRunner $runner): int
    {
        $n = $runner->runDue();
        if ($n > 0) {
            $this->info("renewed {$n} subscriptions");
        }

        return self::SUCCESS;
    }
}
