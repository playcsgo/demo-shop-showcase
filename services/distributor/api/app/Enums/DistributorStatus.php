<?php

namespace App\Enums;

/** 停權（suspended）：帳號登入不了，手上的 token 也立刻失效 */
enum DistributorStatus: string
{
    case Active = 'active';
    case Suspended = 'suspended';
}
