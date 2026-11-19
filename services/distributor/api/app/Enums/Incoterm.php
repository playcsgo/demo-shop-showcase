<?php

namespace App\Enums;

/** 由業務依談好的合約設定，只給業務看，不影響計算：運費要貨代報價，這階段不做 */
enum Incoterm: string
{
    case CIF = 'CIF';
    case FOB = 'FOB';
}
