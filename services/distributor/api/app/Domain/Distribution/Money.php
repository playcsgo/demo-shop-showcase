<?php

namespace App\Domain\Distribution;

/** 最小單位 → 顯示金額：JPY、TWD 沒有小數，其他兩位。前台的 formatMoney 用同一份規則 */
class Money
{
    public const CURRENCIES = ['USD', 'TWD', 'JPY', 'HKD', 'SGD', 'MYR'];

    private const ZERO_DECIMAL = ['TWD', 'JPY'];

    /** @return array<string, string> Select 的選項 */
    public static function options(): array
    {
        return array_combine(self::CURRENCIES, self::CURRENCIES);
    }

    public static function format(int $minor, string $currency): string
    {
        $digits = in_array($currency, self::ZERO_DECIMAL, true) ? 0 : 2;

        return $currency.' '.number_format($minor / 10 ** $digits, $digits);
    }
}
