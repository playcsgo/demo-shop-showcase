<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\Models\Role;
use Spatie\Permission\PermissionRegistrar;

/**
 * 5 個後台角色（§8.1）。角色決定「能做什麼」，brand_user 決定「能對哪些品牌做」。
 */
class RolesSeeder extends Seeder
{
    public const PERMISSIONS = [
        'products.view', 'products.manage',
        'orders.view', 'orders.refund',
        'settlements.view', 'settlements.manage',
        'reports.view',
        'system.health',
    ];

    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();
        foreach (self::PERMISSIONS as $p) {
            Permission::findOrCreate($p, 'web');
        }

        $roles = [
            'super_admin' => self::PERMISSIONS,
            'operator' => ['products.view', 'products.manage', 'orders.view', 'orders.refund', 'settlements.view', 'reports.view'],   // 管整個法人
            'brand_manager' => ['products.view', 'products.manage', 'orders.view', 'orders.refund', 'settlements.view', 'reports.view'],
            'cs_agent' => ['products.view', 'orders.view'],
            'finance' => ['orders.view', 'orders.refund', 'settlements.view', 'settlements.manage', 'reports.view', 'system.health'],
        ];
        foreach ($roles as $name => $permissions) {
            Role::findOrCreate($name, 'web')->syncPermissions($permissions);
        }

        $assign = [
            'admin@example.test' => 'super_admin',
            'finance@example.test' => 'finance',
            'wang-operator@example.test' => 'operator',
            'miao-operator@example.test' => 'operator',
            'wang-manager@example.test' => 'brand_manager',
            'ak-manager@example.test' => 'brand_manager',
            'bc-manager@example.test' => 'brand_manager',
            'mt-manager@example.test' => 'brand_manager',
            'cs@example.test' => 'cs_agent',
        ];
        foreach ($assign as $email => $role) {
            User::where('email', $email)->first()?->syncRoles([$role]);
        }
    }
}
