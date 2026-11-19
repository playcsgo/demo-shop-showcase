<?php

namespace App\Domain\Booking;

/**
 * 醫院的同步操作（TCC 的 Try，§6.4.1）：顧客選時段時要當場知道結果。
 * 正式版經 hub 的內部 API（HubClinicGateway）；測試用 FakeClinicGateway。
 */
interface ClinicGateway
{
    /**
     * 保留時段。額滿 → DomainException(slot_full)；醫院連不上 → DomainException(clinic_unavailable)
     *
     * @return array{hold_id: string, expires_at: string}
     */
    public function hold(string $holdKey, string $startAt, string $serviceType): array;
}
