import { type DynamicModule, Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AssetsController } from './assets/assets.controller.js';
import { DbModule } from './db/db.module.js';
import { DemoModule } from './demo/demo.module.js';
import { ENV } from './env.js';
import { LlmModule } from './llm/llm.module.js';
import type { LlmRunner } from './llm/llm.types.js';
import type { ShopSessions } from './auth/shop-session.js';
import type { PartnersDemo } from './demo/partners-demo.js';
import type { ShopClient } from './shop/shop-client.js';
import { ShopModule } from './shop/index.js';
import { ToolsModule } from './tools/tools.module.js';

@Global()
@Module({})
class EnvModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}

// log 只記 ID、方法、路徑、狀態碼：不記 header（cookie）、body（對話內容、密碼）
const httpLog = {
  // 程式自己記 log 時，帶到這些欄位也不會寫出去
  redact: {
    paths: [
      'body',
      'text',
      'email',
      'password',
      '*.body',
      '*.text',
      '*.email',
      '*.password',
    ],
    censor: '[redacted]',
  },
  serializers: {
    req: (req: { id: unknown; method: string; url: string }) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
};

@Module({})
export class AppModule {
  static forRoot(
    env: NodeJS.ProcessEnv,
    logStream?: DestinationStream,
    llm?: LlmRunner,
    shop?: ShopClient,
    sessions?: ShopSessions,
    partners?: PartnersDemo,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [AssetsController],
      imports: [
        EnvModule.forRoot(env),
        LoggerModule.forRoot({
          pinoHttp: logStream ? [httpLog, logStream] : httpLog,
        }),
        DbModule,
        AuthModule,
        ChatModule,
        LlmModule.forRoot(llm),
        ShopModule.forRoot(shop, sessions, partners),
        ToolsModule,
        DemoModule,
      ],
    };
  }
}
