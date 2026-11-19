<?php

namespace App\Enums;

enum ContractStatus: string
{
    case Draft = 'draft';
    case Active = 'active';
    case Superseded = 'superseded';
}
