<?php

use App\Domain\Messaging\Inbox;
use App\Domain\Messaging\Outbox;
use Illuminate\Support\Facades\DB;

it('outbox 必須在交易內寫入', function () {
    expect(fn () => app(Outbox::class)->record('x.happened', 'core-commands', [], 'corr'))
        ->toThrow(LogicException::class);
});

it('outbox 寫入完整的事件信封', function () {
    DB::transaction(fn () => app(Outbox::class)->record('payment.requested', 'core-commands', ['order_no' => 'A1'], 'corr-1', 'AK'));

    $envelope = json_decode(DB::table('outbox_messages')->value('payload'), true);
    expect($envelope)->toHaveKeys(['event_id', 'type', 'version', 'occurred_at', 'correlation_id', 'project_code', 'payload'])
        ->and($envelope['payload']['order_no'])->toBe('A1');
});

it('交易回滾時，outbox 的事件也一起消失（不會送出不存在的訂單）', function () {
    try {
        DB::transaction(function () {
            app(Outbox::class)->record('payment.requested', 'core-commands', [], 'corr');
            throw new RuntimeException('建立訂單失敗');
        });
    } catch (RuntimeException) {
    }

    expect(DB::table('outbox_messages')->count())->toBe(0);
});

it('inbox：同一個事件送 3 次只處理 1 次', function () {
    $count = 0;
    foreach (range(1, 3) as $_) {
        app(Inbox::class)->handleOnce('11111111-1111-1111-1111-111111111111', 'payment.succeeded', function () use (&$count) {
            $count++;
        });
    }

    expect($count)->toBe(1);
});

it('指令依廠商分到各自的佇列；沒設定的照舊送 core-commands', function () {
    // 壓測發現：全部擠在同一條佇列、共用 worker，一個廠商慢就拖累全部
    \Illuminate\Support\Facades\DB::transaction(function () {
        $outbox = app(\App\Domain\Messaging\Outbox::class);
        $outbox->record('payment.requested', 'core-commands', [], 'c1');
        $outbox->record('payment.reconcile.requested', 'core-commands', [], 'c2');
        $outbox->record('shipment.requested', 'core-commands', [], 'c3');
        $outbox->record('something.else', 'core-commands', [], 'c4');
    });

    expect(\Illuminate\Support\Facades\DB::table('outbox_messages')->orderBy('id')->pluck('queue')->all())
        ->toBe(['payment-commands', 'payment-reconcile-commands', 'logistics-commands', 'core-commands']);
});
