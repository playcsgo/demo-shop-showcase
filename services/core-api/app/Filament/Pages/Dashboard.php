<?php

namespace App\Filament\Pages;

use App\Domain\Ops\DemoReset;
use Filament\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Pages\Dashboard as BaseDashboard;
use Filament\Support\Icons\Heroicon;

/** 主控台：多一個 demo 用的「清空所有資料」（只有 super_admin、非正式環境） */
class Dashboard extends BaseDashboard
{
    protected function getHeaderActions(): array
    {
        return [
            Action::make('resetDemo')
                ->label('清空所有資料')
                ->icon(Heroicon::OutlinedTrash)
                ->color('danger')
                ->visible(fn () => auth()->user()->hasRole('super_admin') && DemoReset::allowed())
                ->requiresConfirmation()
                ->modalHeading('清空所有資料？')
                ->modalDescription('訂單、付款、結算、月結單、SQS 佇列（含 DLQ）、Redis、partners 的設定和紀錄全部清空；帳號、品牌、商品、庫存回到種子資料。約 15 秒，完成後所有人（包括你）都要重新登入。')
                ->modalSubmitActionLabel('清空')
                ->action(function () {
                    if (DemoReset::paused()) {
                        Notification::make()->warning()->title('正在清空中，請稍候')->send();

                        return;
                    }
                    DemoReset::startInBackground();
                    Notification::make()->success()->title('開始清空：約 15 秒後完成，完成後請重新登入')->persistent()->send();
                }),
        ];
    }
}
