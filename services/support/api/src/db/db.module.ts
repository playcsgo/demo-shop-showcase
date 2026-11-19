import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { createDb, DB } from './database.js';
import { ENV } from '../env.js';

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ENV],
      useFactory: (env: NodeJS.ProcessEnv) => createDb(env),
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Pool) {}

  async onApplicationShutdown() {
    await this.db.end();
  }
}
