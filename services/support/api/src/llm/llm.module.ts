import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { LlmRunner } from './llm.types.js';
import { ClaudeCliRunner, type ClaudeCliConfig } from './claude-cli.runner.js';

export const LLM_RUNNER = Symbol('LLM_RUNNER');

export function loadLlmConfig(env: NodeJS.ProcessEnv): ClaudeCliConfig {
  // 介面保留可抽換，demo 只實作 claude-cli
  if ((env.LLM_PROVIDER ?? 'claude-cli') !== 'claude-cli')
    throw new Error('LLM_PROVIDER 目前只支援 claude-cli');
  if (!env.CLAUDE_CODE_OAUTH_TOKEN)
    throw new Error('缺少 CLAUDE_CODE_OAUTH_TOKEN');
  // 0 或 NaN 不會出錯，只會讓所有執行永遠排隊
  const maxConcurrent = Number(env.LLM_MAX_CONCURRENT ?? 5);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error('LLM_MAX_CONCURRENT 要是正整數');
  return {
    bin: 'claude',
    token: env.CLAUDE_CODE_OAUTH_TOKEN,
    fastModel: env.LLM_FAST_MODEL || 'claude-haiku-5-5',
    mainModel: env.LLM_MAIN_MODEL || 'claude-sonnet-5-5',
    maxConcurrent,
    killGraceMs: 3000,
    maxRunMs: 120_000,
    maxQueue: 20,
  };
}

@Global()
@Module({})
export class LlmModule {
  /** 測試可以換成假的 runner；正式只有 claude-cli */
  static forRoot(runner?: LlmRunner): DynamicModule {
    return {
      module: LlmModule,
      providers: [
        runner
          ? { provide: LLM_RUNNER, useValue: runner }
          : {
              provide: LLM_RUNNER,
              useFactory: () => new ClaudeCliRunner(loadLlmConfig(process.env)),
            },
      ],
      exports: [LLM_RUNNER],
    };
  }
}
