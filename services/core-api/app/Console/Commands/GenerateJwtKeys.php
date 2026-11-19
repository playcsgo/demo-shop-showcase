<?php

namespace App\Console\Commands;

use App\Domain\Auth\JwtService;
use Illuminate\Console\Command;

/** 產生 JWT 簽章用的 RSA 金鑰（不進 git；正式環境放 Secrets Manager） */
class GenerateJwtKeys extends Command
{
    protected $signature = 'auth:keys {--force : 覆蓋既有金鑰}';

    protected $description = '產生 JWT 用的 RSA 金鑰對';

    public function handle(): int
    {
        $private = JwtService::keyPath('jwt-private.pem');
        if (file_exists($private) && ! $this->option('force')) {
            $this->info('金鑰已存在（加 --force 覆蓋）');

            return self::SUCCESS;
        }

        @mkdir(dirname($private), 0700, true);
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($key, $pem);
        file_put_contents($private, $pem);
        file_put_contents(JwtService::keyPath('jwt-public.pem'), openssl_pkey_get_details($key)['key']);
        chmod($private, 0600);

        $this->info('已產生 storage/app/keys/jwt-{private,public}.pem');

        return self::SUCCESS;
    }
}
