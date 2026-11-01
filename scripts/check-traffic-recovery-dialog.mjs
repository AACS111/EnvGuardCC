import test from 'node:test';
import assert from 'node:assert/strict';
import { showTrafficRecoveryDialog } from '../desktop/traffic-recovery-dialog.mjs';

test('退出冲突时展示差异，确认保留更改后重新走正常退出', async () => {
  const dialogs = [], calls = [];
  const result = await showTrafficRecoveryDialog({
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 }; } },
    error: Object.assign(new Error('配置已变化'), { code: 'FLCLASH_MERGE_AVAILABLE' }),
    getStatus: async () => ({ recovery: { kind: 'merge', fingerprint: 'abc', changes: [{ path: 'proxies[1].port', change: 'modified' }], backupDir: '/backup' } }),
    request: async (action, body) => { calls.push({ action, body }); },
  });
  assert.equal(result, true);
  assert.match(dialogs[0].detail, /proxies\[1\]\.port/);
  assert.deepEqual(calls, [{ action: 'restore-preserving-changes', body: { fingerprint: 'abc' } }]);
});

test('恢复原备份必须二次确认，取消不会覆盖', async () => {
  const calls = [], answers = [1, 1, 3];
  const result = await showTrafficRecoveryDialog({
    dialog: { showMessageBox: async () => ({ response: answers.shift() }) },
    error: Object.assign(new Error('存在冲突'), { code: 'FLCLASH_CONFLICT' }),
    getStatus: async () => ({ recovery: { kind: 'conflict', fingerprint: 'abc', originalValid: true, backupDir: '/backup' } }),
    request: async (...args) => calls.push(args),
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('待重载时可以先打开 FlClash，再选择检查并退出', async () => {
  const calls = [], answers = [0, 1];
  const result = await showTrafficRecoveryDialog({
    dialog: { showMessageBox: async () => ({ response: answers.shift() }) },
    error: Object.assign(new Error('请重载'), { code: 'FLCLASH_RELOAD_REQUIRED' }),
    getStatus: async () => ({}),
    request: async action => calls.push(action),
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['open-flclash']);
});
