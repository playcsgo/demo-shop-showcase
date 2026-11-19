<?php

namespace App\Filament\Support;

use App\Models\Brand;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * ABAC 的查詢條件：把「這個人能看哪些品牌」轉成 SQL 的 WHERE（§8.1，參考 interview-prep 圖 11）。
 *
 * 為什麼不用 Eloquent 的 Global Scope？
 * Global Scope 會套用到「所有」查詢，包括 core 的業務邏輯、背景 worker、對帳排程，
 * 只要剛好有人登入後台，就可能讓那些查詢少看到資料。所以只在後台的 Resource 查詢明確套用。
 */
class BrandScope
{
    public static function user(): User
    {
        /** @var User */
        return auth()->user();
    }

    public static function products(Builder $query): Builder
    {
        $scope = self::user()->brandScope();

        return $scope === null ? $query : $query->whereIn('brand_id', $scope);
    }

    public static function orders(Builder $query): Builder
    {
        $scope = self::user()->brandScope();

        return $scope === null ? $query : $query->whereHas('items', fn ($q) => $q->whereIn('brand_id', $scope));
    }

    public static function statements(Builder $query): Builder
    {
        $scope = self::user()->legalEntityScope();

        return $scope === null ? $query : $query->whereIn('legal_entity_id', $scope);
    }

    public static function brandOptions(): array
    {
        $scope = self::user()->brandScope();

        return Brand::query()->when($scope !== null, fn ($q) => $q->whereIn('id', $scope))
            ->get()->mapWithKeys(fn ($b) => [$b->id => "{$b->project_code} {$b->name}"])->all();
    }
}
