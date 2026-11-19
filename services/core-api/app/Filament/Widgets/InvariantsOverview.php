<?php

namespace App\Filament\Widgets;

use App\Domain\Reconciliation\InvariantChecker;
use Filament\Widgets\StatsOverviewWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;

/** 首頁：帳的健康狀況（混沌測試時現場看這裡） */
class InvariantsOverview extends StatsOverviewWidget
{
    protected ?string $pollingInterval = '5s';

    protected ?string $heading = '對帳（不變式）';

    public static function canView(): bool
    {
        return auth()->user()?->can('system.health') ?? false;
    }

    protected function getStats(): array
    {
        $checker = app(InvariantChecker::class);
        $stats = [];

        foreach ($checker->check() as $name => $r) {
            $stats[] = Stat::make($name, $r['ok'] ? '✅ 一致' : "❌ {$r['count']} 筆不一致")
                ->color($r['ok'] ? 'success' : 'danger')->description($r['detail'] ?: null);
        }
        foreach ($checker->inFlight() as $name => $n) {
            $stats[] = Stat::make(['pending_payment_orders' => '等待付款', 'outbox_pending' => 'outbox 待送', 'shipments_in_transit' => '配送中包裹',
                'bookings_pending' => '預約確認中', 'authorizations_open' => '授權未結（待請款／取消）', 'refunds_pending' => '退款處理中'][$name] ?? $name, (string) $n);
        }

        return $stats;
    }
}
