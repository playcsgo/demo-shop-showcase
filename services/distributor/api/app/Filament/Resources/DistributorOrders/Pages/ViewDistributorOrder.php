<?php

namespace App\Filament\Resources\DistributorOrders\Pages;

use App\Filament\Resources\DistributorBatches\DistributorBatchResource;
use App\Filament\Resources\DistributorOrders\DistributorOrderResource;
use App\Models\DistributorOrder;
use Filament\Resources\Pages\ViewRecord;

class ViewDistributorOrder extends ViewRecord
{
    protected static string $resource = DistributorOrderResource::class;

    public function getBreadcrumbs(): array
    {
        /** @var DistributorOrder $order */
        $order = $this->record;

        return [
            DistributorBatchResource::getUrl() => '經銷商批次',
            DistributorBatchResource::getUrl('view', ['record' => $order->batch_id]) => $order->batch->batch_no,
            $order->order_no,
        ];
    }

    protected function getHeaderActions(): array
    {
        return DistributorOrderResource::fulfilmentActions();
    }
}
