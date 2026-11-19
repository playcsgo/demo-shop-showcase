<?php

namespace App\Http\Controllers\Api\B2b;

use App\Domain\DomainException;
use App\Enums\DistributorStatus;
use App\Http\Controllers\Controller;
use App\Http\Requests\LoginRequest;
use App\Models\DistributorUser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;

class AuthController extends Controller
{
    public function login(LoginRequest $request): JsonResponse
    {
        $user = DistributorUser::with('distributor')->where('email', $request->validated('email'))->first();

        // 帳號不存在、密碼錯誤、公司停權都回一樣的錯：不讓人試出「哪些 email 有帳號」
        if (! $user || ! Hash::check($request->validated('password'), $user->password) || $user->distributor->status !== DistributorStatus::Active) {
            throw new DomainException('invalid_credentials', '帳號或密碼錯誤', 401);
        }

        Auth::guard('distributor')->login($user);
        $request->session()->regenerate();   // 換 session id：登入前被人知道的 id 不能沿用

        return response()->json(['user' => $this->profile($user)]);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::guard('distributor')->logout();
        $request->session()->invalidate();

        return response()->json(['ok' => true]);
    }

    public function me(Request $request): JsonResponse
    {
        /** @var DistributorUser $user */
        $user = $request->user();

        return response()->json($this->profile($user->load('distributor')));
    }

    /** @return array<string, mixed> */
    private function profile(DistributorUser $user): array
    {
        $d = $user->distributor;

        return [
            'id' => $user->id, 'name' => $user->name, 'email' => $user->email, 'role' => $user->role->value,
            'distributor' => ['code' => $d->code, 'name' => $d->name, 'currency' => $d->currency],
        ];
    }
}
