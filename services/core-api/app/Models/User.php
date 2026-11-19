<?php

namespace App\Models;

use Database\Factories\UserFactory;
use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Spatie\Permission\Traits\HasRoles;

/**
 * 後台使用者（營運人員）。顧客是 Customer。
 * 權限 = RBAC（spatie 角色／權限：能做什麼）＋ ABAC（brand_user：能對哪些品牌做），§8.1
 */
class User extends Authenticatable implements FilamentUser
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, HasRoles, Notifiable;

    protected $fillable = ['name', 'email', 'password', 'legal_entity_id'];

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return ['email_verified_at' => 'datetime', 'password' => 'hashed'];
    }

    /** 有任何後台角色才能進後台 */
    public function canAccessPanel(Panel $panel): bool
    {
        return $this->roles()->exists();
    }

    public function brands(): BelongsToMany
    {
        return $this->belongsToMany(Brand::class);
    }

    /** ABAC 範圍：null＝全部品牌（super_admin、finance）；operator＝自己法人底下所有品牌；其他只限被指派的品牌 */
    public function brandScope(): ?array
    {
        if ($this->hasAnyRole(['super_admin', 'finance'])) {
            return null;
        }
        if ($this->hasRole('operator')) {
            return Brand::where('legal_entity_id', $this->legal_entity_id)->pluck('id')->all();
        }

        return $this->brands()->pluck('brands.id')->all();
    }

    public function canAccessBrand(int $brandId): bool
    {
        $scope = $this->brandScope();

        return $scope === null || in_array($brandId, $scope, true);
    }

    /** 可以看哪些法人的結算單（品牌經理：自己品牌所屬的法人） */
    public function legalEntityScope(): ?array
    {
        $brands = $this->brandScope();

        return $brands === null ? null : Brand::whereIn('id', $brands)->pluck('legal_entity_id')->unique()->values()->all();
    }
}
