<?php

namespace App\Enums;

enum TemperatureClass: string
{
    case Ambient = 'ambient';
    case Chilled = 'chilled';
    case Frozen = 'frozen';
}
