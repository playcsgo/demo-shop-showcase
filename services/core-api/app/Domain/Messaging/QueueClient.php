<?php

namespace App\Domain\Messaging;

/** 佇列的最小介面：正式用 SQS，測試用記憶體版本 */
interface QueueClient
{
    /** @param  list<array{id:string, body:string}>  $messages  @return list<string> 送成功的 id */
    public function sendBatch(string $queue, array $messages): array;

    /** @return list<array{receipt:string, body:string, receive_count:int}> */
    public function receive(string $queue, int $max = 10, int $waitSeconds = 10): array;

    public function delete(string $queue, string $receipt): void;

    /** 清空佇列（demo「清空所有資料」用） */
    public function purge(string $queue): void;

    /** 佇列裡大約還有幾則（監控用；SQS 的數字是近似值） */
    public function depth(string $queue): int;
}
