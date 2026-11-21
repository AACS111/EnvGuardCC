import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNetCore } from './net-core.mjs';
import { createTunnelLookup } from './net-core/tunnel-dns.mjs';

function fixture(t) {
  const children = [], messages = [];
  const lookup = createTunnelLookup({ spawn: (_binary, _args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.NODE_OPTIONS, '');
    const child = new EventEmitter();
    Object.assign(child, { connected: true, ref() {}, unref() {}, channel: { ref() {}, unref() {} },
      send(message, done) { messages.push({ child, ...message }); done?.(); },
      kill() { this.killed = true; this.emit('exit', 0); },
    });
    children.push(child); return child;
  } });
  t.after(() => lookup.dispose());
  return { lookup, children, messages };
}

test('系统 DNS 工作进程复用，显式使用 IPv4，成功后清理取消监听', async t => {
  const f = fixture(t), controller = new AbortController();
  const first = f.lookup('egcc-one.claude.ai', { signal: controller.signal });
  f.children[0].emit('message', { id: f.messages[0].id, address: '198.18.0.10', family: 4 });
  assert.deepEqual(await first, { address: '198.18.0.10', family: 4 });
  controller.abort(); assert.equal(f.children[0].killed, undefined);
  const second = f.lookup('egcc-two.claude.ai');
  assert.equal(f.children.length, 1);
  assert.equal(f.messages[1].family, 4);
  f.children[0].emit('message', { id: f.messages[1].id, address: '198.18.0.20', family: 4 });
  assert.equal((await second).address, '198.18.0.20');
});

test('超时终止隔离进程，晚到答案不能污染新查询，下一轮重建 DNS 工作进程', async t => {
  const f = fixture(t), controller = new AbortController(), reason = new Error('probe timeout');
  const first = f.lookup('egcc-one.claude.ai', { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(first, error => error === reason);
  assert.equal(f.children[0].killed, true);
  const second = f.lookup('egcc-two.claude.ai');
  assert.equal(f.children.length, 2);
  f.children[0].emit('message', { id: f.messages[1].id, address: '203.0.113.1', family: 4 });
  f.children[1].emit('message', { id: f.messages[1].id, address: '198.18.0.20', family: 4 });
  assert.equal((await second).address, '198.18.0.20');
});

test('已取消查询不启动进程，查询错误和工作进程退出均明确失败', async t => {
  const f = fixture(t);
  await assert.rejects(f.lookup('egcc-test.claude.ai', { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  assert.equal(f.children.length, 0);
  const missing = f.lookup('egcc-test.claude.ai');
  f.children[0].emit('message', { id: f.messages[0].id, error: { code: 'ENOTFOUND', message: 'not found' } });
  await assert.rejects(missing, { code: 'ENOTFOUND' });
  const pending = f.lookup('egcc-test.claude.ai');
  f.children[0].emit('exit', 1);
  await assert.rejects(pending, /DNS 工作进程/);
});

test('真实隔离进程仍调用系统解析器，停止后不残留子进程', async t => {
  const lookup = createTunnelLookup(); t.after(() => lookup.dispose());
  assert.equal((await lookup('localhost')).address, '127.0.0.1');
  lookup.dispose();
});

test('隧道探测超时把取消信号传给 DNS，不能只丢弃结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const core = createNetCore({ binary: 'test', homeDir: '.', configPath: 'test.yaml',
    lookup: (_host, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  const pending = core.tunnelStatus(); t.mock.timers.tick(8000);
  await assert.rejects(pending, /隧道解析探测超时/);
  assert.equal(signal?.aborted, true);
});

test('DNS 查询返回公网地址时仍然拒绝判定 TUN 已接管', async () => {
  const core = createNetCore({ binary: 'test', homeDir: '.', configPath: 'test.yaml',
    lookup: async () => ({ address: '203.0.113.1', family: 4 }),
  });
  assert.equal((await core.tunnelStatus()).active, false);
});
