import test from 'node:test';
import assert from 'node:assert/strict';
import { startDesktopServices } from '../desktop/start-services.mjs';

test('自动保护直接走保护启动，避免预先启动旧 TUN 再重复切换', async () => {
  const calls = [];
  await startDesktopServices({
    kernel: { enabled: true, start: async () => { calls.push('kernel-start'); return true; } },
    autoStartProtection: true,
    configureProtection: async enabled => { calls.push(['protect', enabled]); },
  });
  assert.deepEqual(calls, [['protect', true]]);
});

test('手动保护模式保留普通代理、连接采样和订阅刷新，随后建立未保护阻断', async () => {
  const calls = [];
  await startDesktopServices({
    kernel: {
      enabled: true, start: async () => { calls.push('proxy'); return true; },
      connectionLog: { start: () => calls.push('sample') },
      startAutoRefresh: () => calls.push('refresh'), startPublicDnsSync: () => calls.push('dns'),
    },
    autoStartProtection: false, configureProtection: async enabled => calls.push(['protect', enabled]),
  });
  assert.deepEqual(calls, ['proxy', 'sample', 'refresh', 'dns', ['protect', false]]);
});

test('退出打断启动，启动失败如实报告，保护错误不能假装成功', async () => {
  let stopping = false;
  const calls = [];
  const options = {
    kernel: { enabled: true, start: async () => { stopping = true; return true; } },
    autoStartProtection: false, stopping: () => stopping,
    configureProtection: async () => calls.push('protect'),
  };
  await startDesktopServices(options);
  assert.deepEqual(calls, []);
  stopping = false;
  options.kernel.start = async () => false;
  options.logger = message => calls.push(message);
  await startDesktopServices(options);
  assert.match(calls[0], /内核未能启动/);
  assert.equal(calls[1], 'protect');
  await assert.rejects(startDesktopServices({ ...options, autoStartProtection: true,
    configureProtection: async () => { throw new Error('guard failed'); },
  }), /guard failed/);
});

test('自动保护失败仍保留普通代理，报告原始失败；退出期间不重新拉起', async () => {
  let starts = 0, closing = false;
  const options = {
    kernel: { enabled: true, start: async () => { starts++; return true; } },
    autoStartProtection: true, stopping: () => closing,
    configureProtection: async () => { throw new Error('authorization cancelled'); },
  };
  await assert.rejects(startDesktopServices(options), /authorization cancelled/);
  assert.equal(starts, 1);
  options.configureProtection = async () => { closing = true; throw new Error('closing'); };
  await assert.rejects(startDesktopServices(options), /closing/);
  assert.equal(starts, 1);
});
