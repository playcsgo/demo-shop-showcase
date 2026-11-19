<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\Models\Role;
use Spatie\Permission\PermissionRegistrar;

/** 員工帳號和權限。都是虛構的；密碼都是 0204。可以重複執行 */
class DatabaseSeeder extends Seeder
{
    public const ROLES = [
        'sales' => ['distributors.manage', 'country_rules.manage', 'distributor_orders.review', 'demand_board.view'],
        'product_manager' => ['products.manage'],
    ];

    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();

        foreach (self::ROLES as $role => $permissions) {
            foreach ($permissions as $p) {
                Permission::findOrCreate($p, 'web');
            }
            Role::findOrCreate($role, 'web')->syncPermissions($permissions);
        }
        Role::findOrCreate('super_admin', 'web')->syncPermissions(Permission::all());

        $staff = [
            ['admin@example.test', '總管理', 'super_admin'],
            ['sales-a@example.test', '業務 A', 'sales'],
            ['sales-b@example.test', '業務 B', 'sales'],
            ['product@example.test', '商品管理', 'product_manager'],
        ];
        // 共用一個雜湊：bcrypt 故意很慢，每個帳號都算一次會拖慢測試；firstOrCreate 重跑也不會把人踢出後台
        $hash = bcrypt('0204');
        foreach ($staff as [$email, $name, $role]) {
            User::firstOrCreate(['email' => $email], ['name' => $name, 'password' => $hash])->syncRoles([$role]);
        }

        $this->call(DistributorDemoSeeder::class);
    }
}
