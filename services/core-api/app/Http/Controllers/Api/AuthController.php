<?php

namespace App\Http\Controllers\Api;

use App\Domain\Auth\JwtService;
use App\Http\Controllers\Controller;
use App\Models\Customer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

class AuthController extends Controller
{
    /** 顧客登入 → 簽發短效 JWT（BFF 會把它存在伺服器端 session，不交給瀏覽器） */
    public function login(Request $request, JwtService $jwt): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email', 'password' => 'required|string']);

        $customer = Customer::where('email', $data['email'])->first();
        if (! $customer || ! Hash::check($data['password'], $customer->password)) {
            return response()->json(['error' => 'invalid_credentials'], 401);
        }

        return response()->json($jwt->issueForCustomer($customer->id) + [
            'customer' => ['id' => $customer->id, 'name' => $customer->name, 'email' => $customer->email],
        ]);
    }

    public function jwks(JwtService $jwt): JsonResponse
    {
        return response()->json($jwt->jwks())->header('Cache-Control', 'public, max-age=300');
    }

    public function me(Request $request): JsonResponse
    {
        $c = $request->user();

        return response()->json(['id' => $c->id, 'name' => $c->name, 'email' => $c->email]);
    }
}
