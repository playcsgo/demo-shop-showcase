<?php

it('未登入開後台：導到登入頁，不是 JSON 401', function () {
    $this->get('/admin')->assertRedirect('/admin/login');
    $this->get('/admin/distributor-batches')->assertRedirect('/admin/login');
    $this->get('/admin/login')->assertOk();
});

it('未登入打 API：一律 JSON 401，瀏覽器的 Accept 也一樣', function (string $uri) {
    $this->get($uri, ['Accept' => 'text/html'])
        ->assertUnauthorized()
        ->assertExactJson(['error' => 'unauthenticated', 'message' => '請先登入']);
})->with(['/api/v1/b2b/me', '/api/v1/b2b/shops']);
