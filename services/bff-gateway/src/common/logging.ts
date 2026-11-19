import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';

/**
 * debug log（M14）：一律輸出 JSON 到 stdout，收集交給外面（本機 Alloy→Loki、正式環境 Datadog Agent）。
 * 共同欄位：service、level、correlation_id（HTTP 請求自動帶；SQS 訊息用 PinoLogger.runInContext 帶）。
 * 等級由 LOG_LEVEL 控制（.env）；憑證、cookie、金鑰一律遮蔽，不進 log。
 */
export const loggingModule = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'bff-gateway' },
    messageKey: 'msg',
    timestamp: () => `,"ts":"${new Date().toISOString()}"`, // 和 PHP 同一個欄位名
    formatters: { level: (label) => ({ level: label }) },   // "warn" 而不是 40，PHP 和 Node 同一種寫法
    // pino-http 是第一個 middleware：在這裡就決定 correlation id（沿用上游帶來的，沒有就產生），後面的程式都用同一個
    genReqId: (req: IncomingMessage) => {
      const id = String(req.headers['x-correlation-id'] ?? '').slice(0, 64) || randomUUID();
      (req as any).correlationId = id;
      return id;
    },
    customProps: (req: IncomingMessage) => ({ correlation_id: (req as any).correlationId }),
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({ method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ status: res.statusCode }),
    },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-internal-key"]', 'req.headers["x-service-key"]', 'res.headers["set-cookie"]'],
    autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    customSuccessMessage: (req, res, ms) => `${req.method} ${req.url} → ${res.statusCode} (${Math.round(ms)} ms)`,
  },
});
