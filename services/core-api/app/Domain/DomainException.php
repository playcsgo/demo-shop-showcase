<?php

namespace App\Domain;

/**
 * 業務規則被違反（庫存不足、餘額不足、狀態不允許…）。
 * $reason 是給 API 回應用的機器可讀代碼。
 */
class DomainException extends \RuntimeException
{
    public function __construct(public readonly string $reason, string $message = '', public readonly int $status = 422)
    {
        parent::__construct($message ?: $reason);
    }
}
