<?php

namespace App\Domain\Observability;

/**
 * 最小的 DogStatsD 客戶端：用 UDP 把指標丟給 Datadog Agent（port 8125）。
 * UDP 不等回應、送失敗也不丟例外 → 監控壞掉不會拖垮業務。沒設定 host 時什麼都不做。
 * 每個指標都帶 env（DD_ENV）：同一個 Datadog 帳號裡，K8s、sandbox 各套的數字才分得開。
 */
class StatsD
{
    public function __construct(private ?string $host, private int $port = 8125, private ?string $env = null) {}

    /** @param  array<string, string>  $tags */
    public function gauge(string $metric, float|int $value, array $tags = []): void
    {
        $this->send("{$metric}:{$value}|g", $tags);
    }

    /**
     * distribution：每一筆數值都送給 Datadog，由 Datadog 在所有主機合起來算 p50／p95／p99
     * （gauge 只留最後一個值，算不出分佈）
     *
     * @param  array<string, string>  $tags
     */
    public function distribution(string $metric, float|int $value, array $tags = []): void
    {
        $this->send("{$metric}:{$value}|d", $tags);
    }

    public function enabled(): bool
    {
        return (bool) $this->host;
    }

    private function send(string $payload, array $tags): void
    {
        if (! $this->host) {
            return;
        }
        if ($this->env) {
            $tags += ['env' => $this->env];
        }
        if ($tags) {
            $payload .= '|#'.implode(',', array_map(fn ($k, $v) => "{$k}:{$v}", array_keys($tags), $tags));
        }
        $socket = @fsockopen("udp://{$this->host}", $this->port, $errno, $errstr, 0.1);
        if ($socket) {
            @fwrite($socket, $payload);
            fclose($socket);
        }
    }
}
