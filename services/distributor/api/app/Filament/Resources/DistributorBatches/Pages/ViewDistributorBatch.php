<?php

namespace App\Filament\Resources\DistributorBatches\Pages;

use App\Domain\Distribution\BatchReview;
use App\Domain\DomainException;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderType;
use App\Filament\Resources\DistributorBatches\DistributorBatchResource;
use App\Filament\Support\DistributorScope;
use App\Models\DistributorBatch;
use Filament\Actions\Action;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\ViewRecord;

class ViewDistributorBatch extends ViewRecord
{
    protected static string $resource = DistributorBatchResource::class;

    private function batch(): DistributorBatch
    {
        /** @var DistributorBatch */
        return $this->record;
    }

    /** Domain 擋下來的（例如別人剛按過）顯示給業務看；不論成功失敗都重新讀一次狀態 */
    private function attempt(callable $work, string $success): void
    {
        try {
            $work(app(BatchReview::class), DistributorScope::user());
            Notification::make()->success()->title($success)->send();
        } catch (DomainException $e) {
            Notification::make()->danger()->title('無法完成')->body($e->getMessage())->send();
        }
        $this->js('window.location.reload()');   // 下面的訂單列是另一個元件，一起更新
    }

    protected function getHeaderActions(): array
    {
        $status = fn () => $this->batch()->status;

        return [
            Action::make('approve')->label('整批通過')->color('success')->requiresConfirmation()
                ->visible(fn () => $status() === DistributorBatchStatus::InReview)
                ->action(fn () => $this->attempt(fn (BatchReview $r, $by) => $r->approve($this->batch(), $by), '已通過')),
            Action::make('reject')->label('整批退回')->color('danger')
                ->visible(fn () => $status() === DistributorBatchStatus::InReview)
                ->schema([Textarea::make('reason')->label('退回原因（經銷商看得到）')->required()->maxLength(1000)])
                ->action(fn (array $data) => $this->attempt(fn (BatchReview $r, $by) => $r->reject($this->batch(), $by, $data['reason']), '已退回')),
            // demo 示意：之後由財務系統產生確認碼，這裡比對才放行。現在只要求有填，不比對也不存
            Action::make('confirmPayment')->label('確認收款')->color('success')
                ->modalDescription('確認線下已入帳。按下後不能取消也不能復原。')
                ->schema([TextInput::make('payment_code')->label('收款確認碼')->helperText('由財務系統提供')->required()->maxLength(100)])
                ->visible(fn () => $status() === DistributorBatchStatus::AwaitingPayment)
                ->action(fn () => $this->attempt(fn (BatchReview $r, $by) => $r->confirmPayment($this->batch(), $by), '已確認收款')),
            Action::make('start')->label(fn () => $this->batch()->order_type === DistributorOrderType::Stock ? '開始處理' : '開始排產')->color('success')->requiresConfirmation()
                ->modalDescription('這批預付 0%，按下後進入履行。')
                ->visible(fn () => $status() === DistributorBatchStatus::AwaitingStart)
                ->action(fn () => $this->attempt(fn (BatchReview $r, $by) => $r->start($this->batch(), $by), '已開始')),
            Action::make('cancel')->label('取消這批')->color('gray')->requiresConfirmation()
                ->modalDescription('取消後會釋放現貨預留。')
                ->visible(fn () => in_array($status(), [DistributorBatchStatus::AwaitingPayment, DistributorBatchStatus::AwaitingStart], true))
                ->action(fn () => $this->attempt(fn (BatchReview $r, $by) => $r->cancel($this->batch(), $by), '已取消')),
        ];
    }
}
