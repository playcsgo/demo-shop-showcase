import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { allowedOrigins, originGuard } from './origin.js';

// AIC-018：客戶的對話框在商店（storefront）裡，控制台在 support-web，兩個來源都要放行
const env = { SUPPORT_WEB_ORIGIN: 'http://localhost:36173, http://localhost:15173' };

function run(method: string, origin?: string) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  originGuard(allowedOrigins(env))({ method, headers: { origin } } as Request, res, next);
  return { res, next };
}

describe('Origin 檢查（AIC-018）', () => {
  it('商店和控制台的來源都放行', () => {
    expect(run('POST', 'http://localhost:15173').next).toHaveBeenCalled();
    expect(run('POST', 'http://localhost:36173').next).toHaveBeenCalled();
  });

  it('其他網站發的改狀態請求 403', () => {
    const { res, next } = run('POST', 'http://evil.example');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
