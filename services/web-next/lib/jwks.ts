import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * 用 core 公開的公鑰（JWKS）驗證 JWT：BFF 能驗、不能簽（§3.4，RS256 非對稱）。
 * jose 會快取公鑰，不會每次都去抓。
 */
export function createJwtVerifier(coreUrl: string) {
  const jwks = createRemoteJWKSet(new URL(`${coreUrl}/.well-known/jwks.json`))
  return async (token: string): Promise<JWTPayload> => {
    const { payload } = await jwtVerify(token, jwks, { issuer: 'core-api', audience: 'core-api' })
    return payload
  }
}
