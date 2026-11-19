import { type DynamicModule, Module } from '@nestjs/common';
import { BffShopSessions, SHOP_SESSIONS, type ShopSessions } from '../auth/shop-session.js';
import { PARTNERS_DEMO, PartnersAdmin, type PartnersDemo } from '../demo/partners-demo.js';
import { ENV } from '../env.js';
import { CoreApiShopClient } from './core-api-shop-client.js';
import { ProductIndex } from './product-index.js';
import { SHOP_CLIENT, type ShopClient } from './shop-client.js';

// 商店的資料都在 core-api（AIC-014）；這裡是呼叫它的 client、商品索引快取、商店登入（AIC-015）和 partners 的 demo 開關（AIC-017）
@Module({})
export class ShopModule {
  /**
   * shop、sessions：測試注入假的；正式環境用 CORE_API_URL、BFF_URL＋SUPPORT_SERVICE_KEY。
   * sessions：客戶是誰由商店的登入決定（AIC-015）
   */
  static forRoot(shop?: ShopClient, sessions?: ShopSessions, partners?: PartnersDemo): DynamicModule {
    return {
      module: ShopModule,
      global: true,
      providers: [
        shop
          ? { provide: SHOP_CLIENT, useValue: shop }
          : {
              provide: SHOP_CLIENT,
              inject: [ENV],
              useFactory: (env: NodeJS.ProcessEnv) =>
                new CoreApiShopClient(env.CORE_API_URL ?? '', env.SUPPORT_SERVICE_KEY ?? ''),
            },
        sessions
          ? { provide: SHOP_SESSIONS, useValue: sessions }
          : {
              provide: SHOP_SESSIONS,
              inject: [ENV],
              useFactory: (env: NodeJS.ProcessEnv) =>
                new BffShopSessions(env.BFF_URL ?? '', env.SUPPORT_SERVICE_KEY ?? ''),
            },
        // demo 面板的物流開關在 partners（AIC-017）
        partners
          ? { provide: PARTNERS_DEMO, useValue: partners }
          : {
              provide: PARTNERS_DEMO,
              inject: [ENV],
              useFactory: (env: NodeJS.ProcessEnv) => new PartnersAdmin(env.PARTNERS_URL ?? ''),
            },
        ProductIndex,
      ],
      exports: [SHOP_CLIENT, SHOP_SESSIONS, PARTNERS_DEMO, ProductIndex],
    };
  }
}
