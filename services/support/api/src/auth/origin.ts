import type { NextFunction, Request, Response } from 'express';

export const allowedOrigins = (env: NodeJS.ProcessEnv) =>
  new Set(
    (env.SUPPORT_WEB_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

/**
 * cookie 會自動帶上，所以要擋其他網站發的請求。SameSite=Lax 已經擋掉大部分，
 * 這裡再檢查 Origin：瀏覽器跨站送出會改狀態的請求時一定會帶
 */
export function originGuard(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      !origin ||
      allowed.has(origin)
    )
      return next();
    res.status(403).json({ message: '不允許的來源' });
  };
}
