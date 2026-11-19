<?php

namespace App\Http\Controllers\Api;

use App\Domain\Auth\JwtService;
use App\Http\Controllers\Controller;
use App\Models\Customer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 服務對服務：BFF 用自己的服務金鑰，替「已在 BFF 登入的顧客」換一張新的短效 JWT。
 * 這樣 BFF 不用保存顧客密碼，也不用把長效 token 交給瀏覽器（§3.4、§8.2）。
 * 正式環境建議改成 mTLS 或 OAuth client credentials；這裡用共享金鑰＋hash_equals 示意。
 */
class ServiceTokenController extends Controller
{
    public function exchange(Request $request, JwtService $jwt): JsonResponse
    {
        $key = (string) config('services.bff.key');
        if ($key === '' || ! hash_equals($key, (string) $request->header('X-Service-Key'))) {
            return response()->json(['error' => 'invalid_service_key'], 401);
        }

        $data = $request->validate(['customer_id' => 'required|integer']);
        $customer = Customer::findOrFail($data['customer_id']);

        return response()->json($jwt->issueForCustomer($customer->id));
    }
}
