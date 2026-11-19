<?php

namespace App\Domain;

/**
 * 業務規則被違反（帳密錯誤、庫存不足、狀態不允許…）：是正常的回應，不是系統錯誤。
 *  - $reason：給程式看的代碼（前台依它決定顯示什麼），例如 insufficient_stock
 *  - $status：HTTP 狀態碼，預設 422
 *  - $details：前台需要的結構化資料（例如要確認哪些禁令），有值才會出現在回應裡
 * bootstrap/app.php 會把它轉成 {"error": reason, "message": ...}，而且不寫 ERROR log（不會觸發告警）
 */
class DomainException extends \RuntimeException
{
    public function __construct(public readonly string $reason, string $message = '', public readonly int $status = 422, public readonly array $details = [])
    {
        parent::__construct($message ?: $reason);
    }
}
