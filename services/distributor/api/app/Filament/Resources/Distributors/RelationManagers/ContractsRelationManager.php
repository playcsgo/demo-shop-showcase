<?php

namespace App\Filament\Resources\Distributors\RelationManagers;

use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\ContractTemplateApplier;
use App\Domain\DomainException;
use App\Enums\ContractStatus;
use App\Filament\Support\DistributorScope;
use App\Filament\Support\ContractTermsForm;
use App\Models\ContractTemplate;
use App\Models\Distributor;
use App\Models\DistributorContract;
use Filament\Actions\Action;
use Filament\Forms\Components\Select;
use Filament\Notifications\Notification;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Model;

/** 合約：套用範本或空白開始 → 逐項修改 → 生效。規則都在 Domain，這裡只負責畫面 */
class ContractsRelationManager extends RelationManager
{
    protected static string $relationship = 'contracts';

    protected static ?string $title = '合約';

    protected static ?string $modelLabel = '合約';

    public static function canViewForRecord(Model $ownerRecord, string $pageClass): bool
    {
        return (bool) auth()->user()?->can('update', $ownerRecord);
    }

    private function distributor(): Distributor
    {
        /** @var Distributor */
        return $this->getOwnerRecord();
    }

    /** @return array<int, string> */
    private function templateOptions(): array
    {
        return ContractTemplate::where('owner_user_id', auth()->id())
            ->where('currency', $this->distributor()->currency)->pluck('name', 'id')->all();
    }

    /** 選單空的時候說原因，不然看起來像壞掉 */
    public function templateHint(): ?string
    {
        return $this->templateOptions() === [] ? "你還沒有 {$this->distributor()->currency} 的範本。先到「合約範本」建一份，或改用「空白草稿」" : null;
    }

    /** Domain 擋下來的都是正常的業務訊息：顯示給業務看，不是系統錯誤 */
    private function attempt(callable $work, string $success): void
    {
        try {
            $work();
            Notification::make()->success()->title($success)->send();
        } catch (DomainException $e) {
            Notification::make()->danger()->title('無法完成')->body($e->getMessage())->send();
        }
    }

    public function table(Table $table): Table
    {
        return $table
            ->defaultSort('version', 'desc')
            ->columns([
                TextColumn::make('version')->label('版本'),
                TextColumn::make('status')->label('狀態')->badge()
                    ->color(fn (ContractStatus $state) => match ($state) {
                        ContractStatus::Active => 'success', ContractStatus::Draft => 'warning', ContractStatus::Superseded => 'gray',
                    }),
                TextColumn::make('incoterm')->label('Incoterm'),
                TextColumn::make('prepay_bps')->label('預付')->formatStateUsing(fn (int $state) => ($state / 100).'%'),
                TextColumn::make('early_bird_discount_bps')->label('早鳥折扣')->formatStateUsing(fn (int $state) => ($state / 100).'%'),
                TextColumn::make('min_lead_days')->label('最短交期')->suffix(' 天'),
                TextColumn::make('activated_at')->label('生效時間')->dateTime('Y-m-d H:i', 'Asia/Taipei')->placeholder('—'),
            ])
            ->headerActions([
                Action::make('applyTemplate')->label('套用範本')
                    ->schema([
                        // 選項只有自己的、幣別相同的範本；Select 也會在伺服器端驗證值必須在選項裡
                        Select::make('template_id')->label('範本')->required()
                            ->options(fn () => $this->templateOptions())
                            ->helperText(fn () => $this->templateHint()),
                    ])
                    ->action(fn (array $data) => $this->attempt(
                        fn () => app(ContractTemplateApplier::class)->apply(ContractTemplate::with('items')->findOrFail($data['template_id']), $this->distributor(), DistributorScope::user()),
                        '已建立草稿',
                    )),
                Action::make('blankDraft')->label('空白草稿')->requiresConfirmation()
                    ->action(fn () => $this->attempt(fn () => app(ContractDrafts::class)->blank($this->distributor()), '已建立草稿')),
                Action::make('renegotiate')->label('重談（複製現行合約）')->requiresConfirmation()
                    ->action(fn () => $this->attempt(fn () => app(ContractDrafts::class)->copyOfActive($this->distributor()), '已建立草稿')),
            ])
            ->recordActions([
                Action::make('viewTerms')->label('檢視')->color('gray')
                    ->visible(fn (DistributorContract $record) => $record->status !== ContractStatus::Draft)
                    ->fillForm(fn (DistributorContract $record) => $record->toTerms())
                    ->schema(ContractTermsForm::fields())->disabledForm()
                    ->modalSubmitAction(false)->modalWidth('6xl'),
                Action::make('editTerms')->label('修改')
                    ->visible(fn (DistributorContract $record) => $record->status === ContractStatus::Draft)
                    ->fillForm(fn (DistributorContract $record) => $record->toTerms())
                    ->schema(ContractTermsForm::fields())->modalWidth('6xl')
                    ->action(fn (DistributorContract $record, array $data) => $this->attempt(fn () => app(ContractDrafts::class)->save($record, $data), '已存檔')),
                Action::make('activate')->label('生效')->color('success')
                    ->visible(fn (DistributorContract $record) => $record->status === ContractStatus::Draft)
                    ->modalDescription('生效後舊版保留但不再使用，這份不能再修改。')
                    ->requiresConfirmation()
                    ->action(fn (DistributorContract $record) => $this->attempt(
                        fn () => app(ContractActivator::class)->activate($record, DistributorScope::user()),
                        '合約已生效',
                    )),
            ]);
    }
}
