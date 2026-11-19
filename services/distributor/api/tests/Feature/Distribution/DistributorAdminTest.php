<?php

use App\Filament\Resources\Distributors\Pages\CreateDistributor;
use App\Filament\Resources\Distributors\Pages\EditDistributor;
use App\Filament\Resources\Distributors\Pages\ListDistributors;
use App\Filament\Resources\Distributors\RelationManagers\ShopsRelationManager;
use App\Filament\Resources\Distributors\RelationManagers\UsersRelationManager;
use App\Models\Distributor;
use App\Models\DistributorUser;
use Database\Seeders\DistributorDemoSeeder;
use Filament\Actions\Testing\TestAction;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;

function distributor(string $code): Distributor
{
    return Distributor::where('code', $code)->firstOrFail();
}

beforeEach(fn () => $this->seed(DistributorDemoSeeder::class));

it('AC-1：業務的列表只有自己負責的經銷商', function () {
    $this->actingAs(staff('sales-a@example.test'));

    Livewire::test(ListDistributors::class)
        ->assertCanSeeTableRecords([distributor('D-PACIFIC'), distributor('D-ISLAND')])
        ->assertCanNotSeeTableRecords([distributor('D-NORTH')]);
});

it('AC-1：業務開別人的經銷商：回 404', function () {
    $this->actingAs(staff('sales-a@example.test'));

    $this->get('/admin/distributors/'.distributor('D-NORTH')->id.'/edit')->assertNotFound();
    $this->get('/admin/distributors/'.distributor('D-PACIFIC')->id.'/edit')->assertOk();
});

it('AC-1：super_admin 全部看得到；客服進不了', function () {
    $this->actingAs(staff('admin@example.test'));
    Livewire::test(ListDistributors::class)->assertCanSeeTableRecords(Distributor::all());
    $this->get('/admin/distributors/'.distributor('D-NORTH')->id.'/edit')->assertOk();

    $this->actingAs(staff('product@example.test'));
    $this->get('/admin/distributors')->assertForbidden();
});

it('業務新增的經銷商一定掛在自己名下', function () {
    $this->actingAs($sales = staff('sales-a@example.test'));

    Livewire::test(CreateDistributor::class)
        ->fillForm(['code' => 'D-NEW', 'name' => '新經銷商', 'currency' => 'USD', 'status' => 'active'])
        ->call('create')->assertHasNoFormErrors();

    expect(distributor('D-NEW')->sales_user_id)->toBe($sales->id);
});

it('AC-4：業務可以替自己的經銷商新增 shop；國家要從清單選', function () {
    $this->actingAs(staff('sales-a@example.test'));
    $d = distributor('D-ISLAND');
    $rm = fn () => Livewire::test(ShopsRelationManager::class, ['ownerRecord' => $d, 'pageClass' => EditDistributor::class]);

    $rm()->callAction(TestAction::make('create')->table(), ['name' => '高雄倉', 'country_code' => 'TW', 'city' => '高雄市', 'address' => '示意地址'])
        ->assertHasNoFormErrors();
    expect($d->shops()->where('name', '高雄倉')->value('country_code'))->toBe('TW');

    $rm()->callAction(TestAction::make('create')->table(), ['name' => '錯的', 'country_code' => 'XX', 'city' => 'x', 'address' => 'x'])
        ->assertHasFormErrors(['country_code']);
});

it('AC-1：別的業務打不開這家經銷商的帳號和 shop 管理', function () {
    $this->actingAs(staff('sales-b@example.test'));
    $d = distributor('D-ISLAND');

    expect(ShopsRelationManager::canViewForRecord($d, EditDistributor::class))->toBeFalse()
        ->and(UsersRelationManager::canViewForRecord($d, EditDistributor::class))->toBeFalse();
    Livewire::test(ShopsRelationManager::class, ['ownerRecord' => $d, 'pageClass' => EditDistributor::class])->assertForbidden();
});

it('業務建帳號時選角色、設密碼；之後可以重設，留空不會蓋掉', function () {
    $this->actingAs(staff('sales-a@example.test'));
    $d = distributor('D-ISLAND');
    $rm = fn () => Livewire::test(UsersRelationManager::class, ['ownerRecord' => $d, 'pageClass' => EditDistributor::class]);

    $rm()->callAction(TestAction::make('create')->table(), ['name' => '新帳號', 'email' => 'new@example.test', 'role' => 'manager', 'password' => 'first-pass'])
        ->assertHasNoFormErrors();
    $user = DistributorUser::where('email', 'new@example.test')->firstOrFail();
    expect($user->role->value)->toBe('manager')->and(Hash::check('first-pass', $user->password))->toBeTrue();

    $rm()->callAction(TestAction::make('edit')->table($user), ['name' => '改名', 'password' => '']);
    expect(Hash::check('first-pass', $user->fresh()->password))->toBeTrue();

    $rm()->callAction(TestAction::make('edit')->table($user), ['password' => 'second-pass']);
    expect(Hash::check('second-pass', $user->fresh()->password))->toBeTrue();
});
