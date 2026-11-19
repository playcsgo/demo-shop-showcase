<?php

namespace App\Http\Requests\B2b;

use App\Enums\DistributorOrderType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** 只檢查格式；業務規則（可不可以買、箱數倍數、交期）留在 Domain */
class SubmitBatchRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'order_type' => ['required', Rule::enum(DistributorOrderType::class)],
            'orders' => ['required', 'array', 'min:1', 'max:50'],
            'orders.*.shop_id' => ['required', 'integer'],
            'orders.*.requested_ship_date' => ['nullable', 'date_format:Y-m-d'],
            'orders.*.items' => ['required', 'array', 'min:1', 'max:100'],
            'orders.*.items.*.product_id' => ['required', 'integer'],
            'orders.*.items.*.qty_cases' => ['required', 'integer', 'min:1', 'max:1000000'],
        ];
    }
}
