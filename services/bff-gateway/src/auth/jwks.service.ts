import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

/**
 * 用 core 公開的公鑰（JWKS）驗證 JWT：BFF 能驗、不能簽（§3.4，RS256 非對稱）。
 * jose 會快取公鑰，不會每次都去抓。
 */
@Injectable()
export class JwksService {
  private readonly jwks;

  constructor(config: ConfigService) {
    this.jwks = createRemoteJWKSet(new URL(`${config.get<string>('CORE_URL') ?? 'http://core-nginx'}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: 'core-api', audience: 'core-api' });
    return payload;
  }
}
