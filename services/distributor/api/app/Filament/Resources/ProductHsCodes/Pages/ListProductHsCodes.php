<?php

namespace App\Filament\Resources\ProductHsCodes\Pages;

use App\Filament\Resources\ProductHsCodes\ProductHsCodeResource;
use Filament\Resources\Pages\ListRecords;

class ListProductHsCodes extends ListRecords
{
    protected static string $resource = ProductHsCodeResource::class;

    protected ?string $heading = '商品 HS code';

    protected static ?string $title = '商品 HS code';
}
