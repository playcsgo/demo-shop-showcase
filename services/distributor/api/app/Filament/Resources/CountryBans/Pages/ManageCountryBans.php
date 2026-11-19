<?php

namespace App\Filament\Resources\CountryBans\Pages;

use App\Domain\Distribution\CountryBanService;
use App\Filament\Resources\CountryBans\CountryBanResource;
use App\Filament\Support\DistributorScope;
use Filament\Actions\CreateAction;
use Filament\Resources\Pages\ManageRecords;

class ManageCountryBans extends ManageRecords
{
    protected static string $resource = CountryBanResource::class;

    protected function getHeaderActions(): array
    {
        return [
            // 走 Service 才有變更紀錄。同一組國家×成分已經有禁令時，就是修改原因
            CreateAction::make()->using(fn (array $data) => app(CountryBanService::class)->save($data['country_code'], (int) $data['ingredient_id'], $data['reason'] ?? null, DistributorScope::user())),
        ];
    }
}
