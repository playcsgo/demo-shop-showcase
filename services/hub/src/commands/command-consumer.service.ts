import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { correlation } from '../common/correlation.js';
import type { Envelope } from '../common/envelope.js';
import { handled } from '../common/metrics.js';
import { scaled } from '../common/time.js';
import { SqsService } from '../messaging/sqs.service.js';
import { CommandHandler } from './command-handler.service.js';

/**
 * 每個廠商一條佇列、每條佇列一個「池子」（固定併發數）：
 *   - 池子有 N 個位子：有空位才去 SQS 拿（只拿空位的數量），拿到就開始做，不等其他人
 *   - 任何一則做完（成功或失敗）就讓出位子，主迴圈馬上補一則 → 慢的那則只佔住它自己那一個位子
 *   - 成功才 delete；失敗不 delete，SQS 過了可見性逾時會重送（最多 5 次，之後進 DLQ）
 * 原本是一次拿一批、Promise.all 等整批做完才拿下一批：一則慢，整批一起等（壓測時每秒只消化約 10 則）
 *
 * N 依 Little's Law：需要同時處理幾則 ＝ 每秒進來幾則 × 每則花多久（主要是等廠商回應）
 *   每秒 40 筆訂單時：金流約 40 則／秒 × 0.46 秒 ≈ 19；物流約 46 × 0.21 ≈ 10；醫院約 6 × 0.36 ≈ 3
 * HUB_QUEUES 決定這個程序處理哪幾條、各多大：本機一個 hub 全包；K8s 可以拆成 hub-payment、hub-logistics…各自擴充
 *
 * NestJS 觀念：生命週期 hook。
 *  - onApplicationBootstrap：app 啟動完成後開始輪詢佇列
 *  - onApplicationShutdown：收到 SIGTERM（K8s 停 Pod）時不再拿新的，手上的做完才結束
 */
const DEFAULT_QUEUES = 'payment-commands:20,payment-reconcile-commands:5,logistics-commands:10,clinic-commands:5,line-commands:5,core-commands:5';

class Pool {
  inFlight = 0;
  processed = 0;
  failed = 0;
  private wake: (() => void) | null = null;

  constructor(readonly queue: string, readonly size: number) {}

  /** 有位子空出來時叫醒主迴圈 */
  release(): void {
    this.inFlight--;
    this.wakeUp();
  }

  wakeUp(): void {
    this.wake?.();
    this.wake = null;
  }

  waitForSlot(): Promise<void> {
    return new Promise((r) => { this.wake = r; });
  }
}

@Injectable()
export class CommandConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommandConsumer.name);
  private running = false;
  private loops: Promise<void>[] = [];
  readonly pools: Pool[];

  constructor(private readonly sqs: SqsService, private readonly handler: CommandHandler, private readonly pino: PinoLogger) {
    // 空字串＝這個程序不消費佇列（K8s 的 hub-api 只接 webhook 和內部 API）；沒設定才用預設（本機一個 hub 全包）
    this.pools = (process.env.HUB_QUEUES ?? DEFAULT_QUEUES).split(',').filter(Boolean).map((spec) => {
      const [queue, size] = spec.trim().split(':');
      return new Pool(queue, Math.max(1, Number(size) || 5));
    });
  }

  onApplicationBootstrap() {
    if (process.env.DISABLE_CONSUMER === '1') return; // 測試時不啟動
    this.running = true;
    this.loops = this.pools.map((pool) => this.poll(pool));
    this.logger.log({ pools: this.pools.map((p) => `${p.queue}:${p.size}`) }, 'command consumers started');
  }

  async onApplicationShutdown() {
    this.running = false;
    for (const pool of this.pools) pool.wakeUp(); // 叫醒正在等位子的迴圈，讓它看到 running=false 後結束
    await Promise.all(this.loops);
    // 手上的做完才結束：K8s 關 Pod 時不會做到一半
    while (this.pools.some((p) => p.inFlight > 0)) await new Promise((r) => setTimeout(r, 100));
  }

  /** 每個池子的狀況（/health 顯示：用了幾個位子、處理了幾則） */
  stats() {
    return this.pools.map((p) => ({ queue: p.queue, size: p.size, in_flight: p.inFlight, processed: p.processed, failed: p.failed }));
  }

  private async poll(pool: Pool): Promise<void> {
    while (this.running) {
      const free = pool.size - pool.inFlight;
      if (free <= 0) {
        await pool.waitForSlot(); // 位子滿了：等任何一則做完
        continue;
      }
      let messages: Awaited<ReturnType<SqsService['receive']>>;
      try {
        // 只拿空位的數量（SQS 一次最多 10 則）；佇列是空的就 long poll 等 5 秒，不會空轉
        messages = await this.sqs.receive(pool.queue, 5, free);
      } catch (e) {
        this.logger.error({ queue: pool.queue, err: (e as Error).message }, 'poll error');
        await new Promise((r) => setTimeout(r, scaled(2000)));
        continue;
      }
      for (const m of messages) {
        pool.inFlight++;
        void this.process(pool, m).finally(() => pool.release()); // 不 await：開始做就去拿下一則
      }
    }
  }

  private async process(pool: Pool, m: { receipt: string; body: string; receiveCount: number }): Promise<void> {
    const started = Date.now();
    const cmd = JSON.parse(m.body) as Envelope<any>;
    // 這則訊息處理期間的所有 log（含呼叫廠商）都自動帶上 correlation_id、event_id、order_no
    await this.pino.runInContext(() => correlation.run(cmd.correlation_id, async () => {
      try {
        this.logger.debug({ receive_count: m.receiveCount, queue: pool.queue }, `command ${cmd.type} received`);
        await this.handler.handle(cmd, m.receiveCount);
        await this.sqs.delete(pool.queue, m.receipt);
        pool.processed++;
        handled(`hub.${cmd.type}`, started);   // 處理時間：拿到指令 → 處理完、刪掉訊息
        this.logger.log({ ms: Date.now() - started, queue: pool.queue }, `command ${cmd.type} done`);
      } catch (e) {
        // handler 故意丟出的（例如醫院確認 504：可能已經確認、只是回應遺失）也走這裡：不 delete，讓 SQS 晚點重送
        pool.failed++;
        this.logger.warn({ receive_count: m.receiveCount, queue: pool.queue, err: (e as Error).message }, `command ${cmd.type} failed, SQS will redeliver`);
      }
    }), { bindings: { correlation_id: cmd.correlation_id, event_id: cmd.event_id, command: cmd.type, order_no: cmd.payload?.order_no } });
  }
}
