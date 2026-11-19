import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * NestJS 觀念：Middleware（在 Guard 之前執行）。
 * 每個請求一個 correlation id：往下帶給 core（X-Correlation-Id），一路寫進 outbox、SQS、hub 的 log → 可以串起整條追蹤。
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // pino-http（logging.ts）通常已經決定好了；沒有的話（例如測試）才自己產生
    const id = (req as any).correlationId ?? ((req.header('x-correlation-id') ?? '').slice(0, 64) || randomUUID());
    (req as any).correlationId = id;
    res.setHeader('x-correlation-id', id);
    next();
  }
}
