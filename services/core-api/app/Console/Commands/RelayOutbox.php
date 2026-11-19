<?php

namespace App\Console\Commands;

use App\Domain\Messaging\OutboxRelay;
use App\Domain\Ops\DemoReset;
use Illuminate\Console\Command;

/** 常駐程序：把 outbox 的事件送到 SQS（core-relay 容器） */
class RelayOutbox extends Command
{
    protected $signature = 'outbox:relay {--once : 只跑一輪}';

    protected $description = 'Outbox → SQS 發送程序';

    private bool $running = true;

    public function handle(OutboxRelay $relay): int
    {
        $this->trap([SIGTERM, SIGINT], fn () => $this->running = false); // K8s 停 Pod 時優雅結束

        do {
            if (DemoReset::paused()) {   // demo 清空資料中：不讀 outbox
                sleep(1);
                continue;
            }
            $sent = $relay->relayOnce();
            if ($sent > 0) {
                $this->line("sent {$sent}");
            } elseif (! $this->option('once')) {
                usleep(config('messaging.relay.idle_sleep_ms') * 1000);
            }
        } while ($this->running && ! $this->option('once'));

        return self::SUCCESS;
    }
}
