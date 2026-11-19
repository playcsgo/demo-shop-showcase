<?php

namespace App\Domain\Messaging;

/** 測試用：不需要 LocalStack */
class InMemoryQueueClient implements QueueClient
{
    /** @var array<string, list<string>> */
    public array $queues = [];

    public function sendBatch(string $queue, array $messages): array
    {
        foreach ($messages as $m) {
            $this->queues[$queue][] = $m['body'];
        }

        return array_column($messages, 'id');
    }

    public function receive(string $queue, int $max = 10, int $waitSeconds = 10): array
    {
        $out = [];
        foreach (array_splice($this->queues[$queue], 0, $max) as $i => $body) {
            $out[] = ['receipt' => (string) $i, 'body' => $body, 'receive_count' => 1];
        }

        return $out;
    }

    public function delete(string $queue, string $receipt): void {}

    public function purge(string $queue): void
    {
        $this->queues[$queue] = [];
    }

    public function depth(string $queue): int
    {
        return count($this->queues[$queue] ?? []);
    }

    public function push(string $queue, array $envelope): void
    {
        $this->queues[$queue][] = json_encode($envelope);
    }
}
