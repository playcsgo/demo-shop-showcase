<?php

namespace App\Http\Controllers\Api\B2b;

use App\Http\Controllers\Controller;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ShopController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        return response()->json(['data' => $this->ownShops($request)->orderBy('id')->get()->map($this->present(...))]);
    }

    public function show(Request $request, int $id): JsonResponse
    {
        return response()->json($this->present($this->ownShops($request)->findOrFail($id)));   // 別家的 → 查不到 → 404
    }

    /** @return Builder<DistributorShop> */
    private function ownShops(Request $request): Builder
    {
        /** @var DistributorUser $user */
        $user = $request->user();

        return DistributorShop::where('distributor_id', $user->distributor_id);
    }

    /** @return array<string, mixed> */
    private function present(DistributorShop $s): array
    {
        return $s->only('id', 'name', 'country_code', 'city', 'address', 'destination_port');
    }
}
