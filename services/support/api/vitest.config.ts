import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false, // 資料庫測試共用 support_test
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
  },
});
