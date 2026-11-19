// AI 層（llm、tools、ask、join）只能從這裡拿商店的東西，見 architecture.ts
export { ShopModule } from './shop.module.js';
export {
  SHOP_CLIENT,
  ShopUnavailable,
  type Actor,
  type ProductDoc,
  type ProductSpec,
  type ShopClient,
} from './shop-client.js';
export { ProductIndex } from './product-index.js';
