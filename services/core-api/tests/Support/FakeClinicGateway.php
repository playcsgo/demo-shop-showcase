<?php

namespace Tests\Support;

use App\Domain\Booking\ClinicGateway;
use App\Domain\DomainException;

/** 測試用的醫院：記住保留，可以設定成額滿 */
class FakeClinicGateway implements ClinicGateway
{
    public bool $full = false;

    /** @var array<string, array{hold_id: string, start_at: string}> hold_key → hold */
    public array $holds = [];

    public function hold(string $holdKey, string $startAt, string $serviceType): array
    {
        if ($this->full) {
            throw new DomainException('slot_full', '這個時段剛被訂走', 409);
        }
        $this->holds[$holdKey] ??= ['hold_id' => 'hold_'.count($this->holds), 'start_at' => $startAt];

        return ['hold_id' => $this->holds[$holdKey]['hold_id'], 'expires_at' => now()->addMinutes(30)->toIso8601String()];
    }
}
