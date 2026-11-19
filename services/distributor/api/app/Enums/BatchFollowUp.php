<?php

namespace App\Enums;

/** 這一批現在輪到誰。沒有串金流和貨運，所以看的是狀態和日期，不是外部事件 */
enum BatchFollowUp: string
{
    case NeedsAction = 'needs_action';
    case Waiting = 'waiting';
    case Ended = 'ended';

    public function label(): string
    {
        return match ($this) {
            self::NeedsAction => '待處理',
            self::Waiting => '等待中',
            self::Ended => '結束',
        };
    }

    public function color(): string
    {
        return match ($this) {
            self::NeedsAction => 'warning',
            self::Waiting => 'info',
            self::Ended => 'gray',
        };
    }
}
