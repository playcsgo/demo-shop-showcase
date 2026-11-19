import { defineConfig } from 'vitest/config';

// 真實模型測試：花額度、手動跑、不進 CI
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.real.ts'],
    testTimeout: 180_000,
    globalSetup: ['test/global-setup.ts'], // Ask 的真實測試要用 support_test 資料庫
    fileParallelism: false,
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
});
