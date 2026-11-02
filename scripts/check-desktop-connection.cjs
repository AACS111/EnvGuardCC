/* eslint-disable @typescript-eslint/no-require-imports -- Use the existing CommonJS TypeScript test harness. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/detection/desktop-connection.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exported = {};
new Function('exports', compiled)(exported);
const { observeDesktopSettings, desktopReadyEvent } = exported;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('桌面接口晚于 React 挂载时，就绪事件重新加载设置', async () => {
  const target = new EventTarget(), values = [];
  const stop = observeDesktopSettings({ target, onSettings: value => values.push(value), onError: assert.fail });
  await flush(); assert.equal(values.length, 0);
  target.envGuardDesktop = { getSettings: async () => ({ autoStartProtection: false }) };
  target.dispatchEvent(new Event(desktopReadyEvent)); await flush();
  assert.deepEqual(values, [{ autoStartProtection: false }]); stop();
});

test('首次 IPC 字符串拒绝可见且页面就绪后可重试', async () => {
  const target = new EventTarget(), values = [], errors = [];
  let ready = false;
  target.envGuardDesktop = { getSettings: () => ready ? Promise.resolve({ enabled: true }) : Promise.reject('native not ready') };
  const stop = observeDesktopSettings({ target, onSettings: value => values.push(value), onError: message => errors.push(message) });
  await flush(); assert.deepEqual(errors, ['native not ready']);
  ready = true; target.dispatchEvent(new Event(desktopReadyEvent)); await flush();
  assert.deepEqual(values, [{ enabled: true }]); stop();
});

test('晚到旧响应与卸载后的响应不会覆盖新状态', async () => {
  const target = new EventTarget(), values = [];
  let oldReply, count = 0;
  target.envGuardDesktop = { getSettings: () => ++count === 1 ? new Promise(resolve => { oldReply = resolve; }) : Promise.resolve('current') };
  const stop = observeDesktopSettings({ target, onSettings: value => values.push(value), onError: assert.fail });
  await flush(); target.dispatchEvent(new Event(desktopReadyEvent)); await flush();
  oldReply('stale'); await flush(); assert.deepEqual(values, ['current']);
  stop(); target.dispatchEvent(new Event(desktopReadyEvent)); await flush(); assert.equal(count, 2);
});
