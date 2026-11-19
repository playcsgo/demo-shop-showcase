import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { SHOP_CLIENT, type ProductIndexEntry, type ShopClient } from './shop-client.js';

export const REFRESH_MS = 5 * 60_000;

/**
 * 給 AI 挑商品用的索引（AC-41）：啟動時從商店拉一次，之後每 5 分鐘更新。
 * 拉失敗就沿用舊的：索引只用來挑商品，價格、庫存一律即時查。
 * 啟動時商店還沒好也不擋啟動，第一次問的時候再拉
 */
@Injectable()
export class ProductIndex implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('product-index');
  private entries: ProductIndexEntry[] = [];
  private loadedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(SHOP_CLIENT) private readonly shop: ShopClient) {}

  onApplicationBootstrap() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      this.entries = await this.shop.productIndex();
      this.loadedAt = Date.now();
    } catch {
      this.logger.warn('商品索引更新失敗，沿用舊的');
    }
  }

  /** 系統提示用的文字：slug｜名稱｜物種｜保健方向 */
  async text(): Promise<string> {
    if (!this.entries.length || Date.now() - this.loadedAt > REFRESH_MS) await this.refresh();
    return this.entries
      .map((d) => [d.slug, d.name, d.species.join(','), d.concerns.join(',')].join('｜'))
      .join('\n');
  }
}
