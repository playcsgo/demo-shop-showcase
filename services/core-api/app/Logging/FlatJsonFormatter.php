<?php

namespace App\Logging;

use Monolog\Formatter\NormalizerFormatter;
use Monolog\LogRecord;

/**
 * debug log（M14）：一行一個 JSON，欄位放在最外層，和 Node（pino）長得一樣：
 *   {"ts":"…","level":"info","service":"core-worker","msg":"…","correlation_id":"…","order_no":"…"}
 * 這樣 Loki／Datadog 用同一種查法（| json | correlation_id="…"）就能跨 PHP、Node 查。
 */
class FlatJsonFormatter extends NormalizerFormatter
{
    public function __construct()
    {
        parent::__construct('Y-m-d\TH:i:s.vP');
    }

    public function format(LogRecord $record): string
    {
        $normalized = $this->normalize($record->toArray());

        return json_encode([
            'ts' => $normalized['datetime'],
            'level' => strtolower($record->level->getName()) === 'warning' ? 'warn' : strtolower($record->level->getName()),
            'service' => config('app.service_name'),
            'msg' => $normalized['message'],
            ...$normalized['extra'],     // Datadog 的 dd.trace_id 在這裡
            ...$normalized['context'],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR)."\n";
    }
}
