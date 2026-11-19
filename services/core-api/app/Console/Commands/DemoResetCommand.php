<?php

namespace App\Console\Commands;

use App\Domain\Ops\DemoReset;
use Illuminate\Console\Command;

/** demo 用：清空所有資料（資料庫、SQS、Redis、partners），容器不動。後台主控台的「清空所有資料」按鈕也是跑這個 */
class DemoResetCommand extends Command
{
    protected $signature = 'demo:reset';

    protected $description = '清空所有 demo 資料（資料庫重建＋種子、SQS、Redis、partners），容器不動';

    public function handle(DemoReset $reset): int
    {
        if (! DemoReset::allowed()) {
            $this->error('正式環境不能清空資料');

            return self::FAILURE;
        }

        $started = microtime(true);
        $reset->run(fn (string $step) => $this->line("demo:reset {$step}"));
        $this->info(sprintf('demo:reset 完成（%.1f 秒）', microtime(true) - $started));

        return self::SUCCESS;
    }
}
