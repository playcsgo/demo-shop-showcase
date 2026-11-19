<?php

namespace App\Domain\Messaging;

use Aws\Sqs\SqsClient;

class SqsQueueClient implements QueueClient
{
    private SqsClient $sqs;

    public function __construct(private array $config)
    {
        $this->sqs = new SqsClient(array_filter([
            'region' => $config['region'],
            'version' => '2012-11-05',
            'endpoint' => $config['endpoint'] ?: null,
            'credentials' => $config['key'] ? ['key' => $config['key'], 'secret' => $config['secret']] : null,
            'http' => ['connect_timeout' => 2, 'timeout' => 15],
        ]));
    }

    public function sendBatch(string $queue, array $messages): array
    {
        if ($messages === []) {
            return [];
        }

        $result = $this->sqs->sendMessageBatch([
            'QueueUrl' => $this->url($queue),
            'Entries' => array_map(fn ($m) => ['Id' => $m['id'], 'MessageBody' => $m['body']], $messages),
        ]);

        return array_column($result->get('Successful') ?? [], 'Id');
    }

    public function receive(string $queue, int $max = 10, int $waitSeconds = 10): array
    {
        $result = $this->sqs->receiveMessage([
            'QueueUrl' => $this->url($queue),
            'MaxNumberOfMessages' => $max,
            'WaitTimeSeconds' => $waitSeconds,          // long polling：沒訊息時等著，不空轉
            'AttributeNames' => ['ApproximateReceiveCount'],
        ]);

        return array_map(fn ($m) => [
            'receipt' => $m['ReceiptHandle'],
            'body' => $m['Body'],
            'receive_count' => (int) ($m['Attributes']['ApproximateReceiveCount'] ?? 1),
        ], $result->get('Messages') ?? []);
    }

    public function delete(string $queue, string $receipt): void
    {
        $this->sqs->deleteMessage(['QueueUrl' => $this->url($queue), 'ReceiptHandle' => $receipt]);
    }

    public function purge(string $queue): void
    {
        try {
            $this->sqs->purgeQueue(['QueueUrl' => $this->url($queue)]);
        } catch (\Aws\Sqs\Exception\SqsException $e) {
            // SQS 同一條佇列 60 秒內只能 purge 一次；上一次的還在清，等於已經在清空
            if ($e->getAwsErrorCode() !== 'AWS.SimpleQueueService.PurgeQueueInProgress') {
                throw $e;
            }
        }
    }

    public function depth(string $queue): int
    {
        $result = $this->sqs->getQueueAttributes([
            'QueueUrl' => $this->url($queue),
            'AttributeNames' => ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        ]);
        $attrs = $result->get('Attributes') ?? [];

        return (int) ($attrs['ApproximateNumberOfMessages'] ?? 0) + (int) ($attrs['ApproximateNumberOfMessagesNotVisible'] ?? 0);
    }

    private function url(string $queue): string
    {
        return rtrim($this->config['prefix'], '/')."/{$queue}";
    }
}
