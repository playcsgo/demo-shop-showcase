<?php

namespace App\Filament\Widgets;

use App\Domain\Reconciliation\InvariantChecker;
use Filament\Widgets\StatsOverviewWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;

/** 首頁：帳的健康狀況 */
class InvariantsOverview extends StatsOverviewWidget
{
    protected ?string $pollingInterval = '5s';

    protected ?string $heading = '對帳（不變式）';

    public static function canView(): bool
    {
        return auth()->user()?->hasRole('super_admin') ?? false;
    }

    protected function getStats(): array
    {
        $stats = [];
        foreach (app(InvariantChecker::class)->check() as $name => $r) {
            $stats[] = Stat::make($name, $r['ok'] ? '✅ 一致' : "❌ {$r['count']} 筆不一致")->color($r['ok'] ? 'success' : 'danger');
        }

        return $stats;
    }
}
