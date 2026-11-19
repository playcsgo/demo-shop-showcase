<?php

namespace App\Domain\Auth;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

/**
 * auth 模組（§3.4，對應電商的 cosign 身分職責）：
 *  - 用私鑰簽 RS256 的短效 JWT
 *  - 公鑰以 JWKS 公開（/.well-known/jwks.json），BFF 或其他服務只需公鑰就能驗證，拿不到簽發能力
 *    （對照電商：HS256 共用密鑰 → 每個驗證者也都能簽）
 */
class JwtService
{
    public const KID = 'core-2026-10';

    private const TTL_SECONDS = 900;

    public function issueForCustomer(int $customerId): array
    {
        $now = time();
        $token = JWT::encode([
            'iss' => 'core-api',
            'aud' => 'core-api',
            'sub' => (string) $customerId,
            'scope' => 'customer',
            'iat' => $now,
            'exp' => $now + self::TTL_SECONDS,
        ], $this->privateKey(), 'RS256', self::KID);

        return ['access_token' => $token, 'token_type' => 'Bearer', 'expires_in' => self::TTL_SECONDS];
    }

    /** @return object|null 驗證失敗回 null */
    public function verify(string $jwt): ?object
    {
        try {
            $claims = JWT::decode($jwt, new Key($this->publicKey(), 'RS256'));
        } catch (\Throwable) {
            return null;
        }

        return ($claims->iss ?? null) === 'core-api' && ($claims->aud ?? null) === 'core-api' ? $claims : null;
    }

    public function jwks(): array
    {
        $details = openssl_pkey_get_details(openssl_pkey_get_public($this->publicKey()));
        $b64 = fn (string $bin) => rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');

        return ['keys' => [[
            'kty' => 'RSA', 'use' => 'sig', 'alg' => 'RS256', 'kid' => self::KID,
            'n' => $b64($details['rsa']['n']), 'e' => $b64($details['rsa']['e']),
        ]]];
    }

    public static function keyPath(string $file): string
    {
        return storage_path("app/keys/{$file}");
    }

    private function privateKey(): string
    {
        return file_get_contents(self::keyPath('jwt-private.pem')) ?: throw new \RuntimeException('缺少 JWT 私鑰，請執行 php artisan auth:keys');
    }

    private function publicKey(): string
    {
        return file_get_contents(self::keyPath('jwt-public.pem')) ?: throw new \RuntimeException('缺少 JWT 公鑰，請執行 php artisan auth:keys');
    }
}
