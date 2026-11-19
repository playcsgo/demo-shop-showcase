<?php

namespace App\Domain\Distribution;

use Carbon\CarbonImmutable;

/** 只跳過週末，不管國定假日：這只是預計回覆日，超過也只標紅 */
class WorkingDays
{
    public static function add(CarbonImmutable $from, int $days): CarbonImmutable
    {
        $date = $from;
        while ($days > 0) {
            $date = $date->addDay();
            if (! $date->isWeekend()) {
                $days--;
            }
        }

        return $date;
    }
}
