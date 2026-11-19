<?php

it('健康檢查和後台登入頁都開得起來', function () {
    $this->get('/up')->assertOk();
    $this->get('/admin/login')->assertOk()->assertSee('經銷商後台');
});

it('未登入：後台導到登入頁', function () {
    $this->get('/admin')->assertRedirect('/admin/login');
});

it('員工可以登入後台', function () {
    $this->actingAs(staff('sales-a@example.test'))->get('/admin')->assertOk();
});
