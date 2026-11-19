<?php

namespace App\Enums;

/** 決定拆包裹與物流商（§5.4）；service 不出貨 */
enum ShippingClass: string
{
    case Standard = 'standard'; // 同單合併成一個包裹
    case Litter = 'litter';     // 貓砂：獨立包裹
    case Bulky = 'bulky';       // 大型商品：每件獨立、走大型物流
    case Service = 'service';   // 服務：不產生包裹

    public function carrier(): ?string
    {
        return match ($this) {
            self::Standard, self::Litter => 'home_delivery',
            self::Bulky => 'bulky_freight',
            self::Service => null,
        };
    }
}
