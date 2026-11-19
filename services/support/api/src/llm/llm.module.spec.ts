import { loadLlmConfig } from './llm.module.js';

const env = {
  CLAUDE_CODE_OAUTH_TOKEN: 't',
  LLM_FAST_MODEL: 'f',
  LLM_MAIN_MODEL: 'm',
};

describe('loadLlmConfig', () => {
  it('讀環境變數，同時執行數預設 5', () => {
    expect(loadLlmConfig(env)).toMatchObject({
      token: 't',
      fastModel: 'f',
      mainModel: 'm',
      maxConcurrent: 5,
      bin: 'claude',
    });
    expect(
      loadLlmConfig({ ...env, LLM_MAX_CONCURRENT: '2' }).maxConcurrent,
    ).toBe(2);
  });

  it.each(['0', '-1', 'abc', '', '1.5'])(
    '同時執行數 %j 不合法，啟動就失敗（否則所有執行會永遠排隊）',
    (value) => {
      expect(() =>
        loadLlmConfig({ ...env, LLM_MAX_CONCURRENT: value }),
      ).toThrow('LLM_MAX_CONCURRENT');
    },
  );

  it('模型設成空字串時用預設值', () => {
    expect(loadLlmConfig({ ...env, LLM_FAST_MODEL: '' }).fastModel).toBe(
      'claude-haiku-5-5',
    );
  });

  it('只有 claude-cli 一種實作，其他值啟動就失敗', () => {
    expect(() => loadLlmConfig({ ...env, LLM_PROVIDER: 'api' })).toThrow(
      'LLM_PROVIDER',
    );
  });

  it('缺 token 啟動就失敗，錯誤訊息不含設定值', () => {
    expect(() =>
      loadLlmConfig({ ...env, CLAUDE_CODE_OAUTH_TOKEN: '' }),
    ).toThrow('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
