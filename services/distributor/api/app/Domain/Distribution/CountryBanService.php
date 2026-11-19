<?php

namespace App\Domain\Distribution;

use App\Models\CountryIngredientBan;
use App\Models\CountryIngredientBanChange;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** 禁令全公司共用，可能被改錯：存禁令和寫變更紀錄在同一個交易，不會有沒留紀錄的改動 */
class CountryBanService
{
    public function save(string $country, int $ingredientId, ?string $reason, User $by): CountryIngredientBan
    {
        $after = ['reason' => $reason ?: null];

        return DB::transaction(function () use ($country, $ingredientId, $after, $by) {
            $ban = CountryIngredientBan::where('country_code', $country)->where('ingredient_id', $ingredientId)->lockForUpdate()->first()
                ?? new CountryIngredientBan(['country_code' => $country, 'ingredient_id' => $ingredientId]);
            $before = $ban->exists ? $ban->only('reason') : null;
            if ($before === $after) {
                return $ban;
            }

            $ban->fill($after)->save();
            $this->record($ban, $before, $after, $by);

            return $ban;
        });
    }

    /** 刪除就是解除：之後的掃描不再警告，已送出的批次不受影響 */
    public function delete(CountryIngredientBan $ban, User $by): void
    {
        DB::transaction(function () use ($ban, $by) {
            $this->record($ban, $ban->only('reason'), null, $by);
            $ban->delete();
        });
    }

    /**
     * @param  array<string, mixed>|null  $before
     * @param  array<string, mixed>|null  $after
     */
    private function record(CountryIngredientBan $ban, ?array $before, ?array $after, User $by): void
    {
        CountryIngredientBanChange::create([
            'country_code' => $ban->country_code, 'ingredient_id' => $ban->ingredient_id, 'changed_by_user_id' => $by->id,
            'before' => $before, 'after' => $after,
        ]);
    }
}
