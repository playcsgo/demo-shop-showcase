<?php

use App\Enums\DistributorStatus;
use App\Models\Distributor;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use Database\Seeders\DistributorDemoSeeder;

beforeEach(fn () => $this->seed(DistributorDemoSeeder::class));

it('AC-2：員工登入後台不等於登入經銷商 API', function () {
    $this->actingAs(staff('sales-a@example.test'))->getJson('/api/v1/b2b/me')->assertStatus(401);
});

it('AC-2：經銷商帳號進不了後台', function () {
    $this->actingAs(distributorUser(), 'distributor')->get('/admin')->assertRedirect('/admin/login');
});

it('沒登入：401', function () {
    $this->getJson('/api/v1/b2b/me')->assertStatus(401)->assertJson(['error' => 'unauthenticated']);
});

it('登入：拿到自己的公司資料，回應不含密碼雜湊', function () {
    $res = $this->postJson('/api/v1/b2b/auth/login', ['email' => 'pacific-buyer@example.test', 'password' => '0204'])->assertOk();

    expect($res->json('user'))->toMatchArray(['email' => 'pacific-buyer@example.test', 'role' => 'buyer'])
        ->and($res->json('user.distributor'))->toMatchArray(['code' => 'D-PACIFIC', 'currency' => 'USD'])
        ->and($res->getContent())->not->toContain('password')->not->toContain('$2y$');

    expect($res->getContent())->not->toContain('access_token');
    $this->getJson('/api/v1/b2b/me')->assertOk()
        ->assertJsonPath('distributor.name', '太平洋寵物貿易')->assertJsonMissingPath('password');
});

it('登入：密碼錯誤和帳號不存在回一樣的錯', function () {
    $wrong = $this->postJson('/api/v1/b2b/auth/login', ['email' => 'pacific-buyer@example.test', 'password' => 'nope'])->assertStatus(401);
    $missing = $this->postJson('/api/v1/b2b/auth/login', ['email' => 'nobody@example.test', 'password' => '0204'])->assertStatus(401);

    expect($wrong->json())->toBe($missing->json());
});

it('經銷商的 session 和員工分開：cookie 名稱不同，HttpOnly', function () {
    $res = $this->postJson('/api/v1/b2b/auth/login', ['email' => 'pacific-buyer@example.test', 'password' => '0204'])->assertOk();

    $cookie = $res->getCookie(\App\Http\Middleware\UseDistributorSessionCookie::COOKIE);
    expect($cookie)->not->toBeNull()->and($cookie->isHttpOnly())->toBeTrue()->and($cookie->getSameSite())->toBe('lax');
    expect(\App\Http\Middleware\UseDistributorSessionCookie::COOKIE)->not->toBe(env('SESSION_COOKIE'));
});

it('登出後 session 失效', function () {
    $this->postJson('/api/v1/b2b/auth/login', ['email' => 'pacific-buyer@example.test', 'password' => '0204'])->assertOk();
    $this->postJson('/api/v1/b2b/auth/logout')->assertOk();
    $this->getJson('/api/v1/b2b/me')->assertStatus(401);
});

it('員工的帳號密碼不能登入經銷商 API', function () {
    $this->postJson('/api/v1/b2b/auth/login', ['email' => 'sales-a@example.test', 'password' => '0204'])->assertStatus(401);
});

it('停權的經銷商：登入不了，已登入的 session 也立刻失效', function () {
    $this->actingAs(distributorUser(), 'distributor');
    Distributor::where('code', 'D-PACIFIC')->update(['status' => DistributorStatus::Suspended]);

    $this->getJson('/api/v1/b2b/me')->assertStatus(401);
    $this->postJson('/api/v1/b2b/auth/login', ['email' => 'pacific-buyer@example.test', 'password' => '0204'])->assertStatus(401);
});

it('AC-3：只拿到自己公司的 shop；查別家的 shop id 回 404', function () {
    $this->actingAs(distributorUser(), 'distributor');
    $res = $this->getJson('/api/v1/b2b/shops')->assertOk();
    expect(collect($res->json('data'))->pluck('name')->all())->toEqualCanonicalizing(['香港門市', '新加坡門市', '澳門門市']);

    $mine = DistributorShop::where('name', '香港門市')->firstOrFail();
    $other = DistributorShop::where('name', '大阪門市')->firstOrFail();
    $this->getJson("/api/v1/b2b/shops/{$mine->id}")->assertOk()->assertJsonPath('country_code', 'HK');
    $this->getJson("/api/v1/b2b/shops/{$other->id}")->assertNotFound()->assertJson(['error' => 'not_found']);
});

it('AC-4：經銷商沒有新增 shop 的 API', function () {
    $this->actingAs(distributorUser(), 'distributor')->postJson('/api/v1/b2b/shops', ['name' => 'x'])->assertStatus(405);
});
