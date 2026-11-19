<?php

namespace App\Models;

use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Spatie\Permission\Traits\HasRoles;

/** 經銷商後台的員工：業務、生管、倉庫、商品管理。權限用 spatie 的角色 */
class User extends Authenticatable implements FilamentUser
{
    use HasRoles;

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return ['password' => 'hashed'];
    }

    public function canAccessPanel(Panel $panel): bool
    {
        return true;
    }

    /** 這家經銷商是不是我管：super_admin 全部；其他人只有負責的 */
    public function managesDistributor(Distributor $distributor): bool
    {
        return $this->hasRole('super_admin') || $distributor->sales_user_id === $this->id;
    }
}
