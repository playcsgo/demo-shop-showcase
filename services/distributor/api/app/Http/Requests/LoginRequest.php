<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/**
 * FormRequest：把「驗證規則」從 Controller 拿出來。
 * Controller 的參數寫 LoginRequest $request → Laravel 先驗證，不過就直接回 422，Controller 根本不會執行
 */
class LoginRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ];
    }
}
