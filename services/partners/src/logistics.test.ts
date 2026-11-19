import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { defaults, resetSettings, settings, updateSettings } from './faults.js';
import { estimate, stepMsFor } from './logistics.js';

// 大型物流 demo（AIC-017）：開關打開時，大型和貓砂整段約 20 分鐘；一般商品照原本的速度

beforeEach(() => resetSettings());

test('預設：每種運送類別都照 stepDelayMs（壓測、sandbox 的行為不變）', () => {
  assert.deepEqual(defaults().logistics.slowClasses, []);
  for (const cls of ['standard', 'litter', 'bulky', undefined]) assert.equal(stepMsFor(cls), settings.logistics.stepDelayMs);
});

test('打開：bulky、litter 每段 slowTotalMs/3，standard 不變', () => {
  updateSettings({ logistics: { slowClasses: ['bulky', 'litter'] } });
  assert.equal(stepMsFor('bulky'), 400_000);
  assert.equal(stepMsFor('litter'), 400_000);
  assert.equal(stepMsFor('standard'), 1500);
});

test('預估和實際時程一致：三段的總時間', () => {
  updateSettings({ logistics: { slowClasses: ['bulky', 'litter'] } });
  assert.deepEqual(estimate('litter'), { shipping_class: 'litter', estimated_seconds: 1200, slow: true });
  assert.deepEqual(estimate('standard'), { shipping_class: 'standard', estimated_seconds: 4.5, slow: false });
});

test('重設之後回到預設（關閉）', () => {
  updateSettings({ logistics: { slowClasses: ['bulky'] } });
  resetSettings();
  assert.equal(stepMsFor('bulky'), 1500);
});

test('slowClasses 只接受清單', () => {
  updateSettings({ logistics: { slowClasses: 'bulky' } });
  assert.deepEqual(settings.logistics.slowClasses, []);
});
