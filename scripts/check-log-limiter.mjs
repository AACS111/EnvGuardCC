import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogLimiter, kernelWarningKey } from './net-core/log-limiter.mjs';
import { createNetCore } from './net-core.mjs';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('日志风暴保留首条、周期总数和最后样本，退出刷新且新故障立即可见', () => {
  const lines = [];
  let time = 0;
  const limiter = createLogLimiter(line => lines.push(line), { now: () => time });
  for (let i = 0; i < 10000; i++) limiter.write('dns timeout', `sample ${i}`);
  assert.deepEqual(lines, ['sample 0']);
  limiter.write('authentication', 'REALITY failure');
  assert.equal(lines.at(-1), 'REALITY failure');
  time = 30000;
  limiter.write('dns timeout', 'latest');
  assert.match(lines.at(-1), /重复 10000 次.*latest/);
  limiter.write('dns timeout', 'pending');
  limiter.flush();
  assert.match(lines.at(-1), /重复 1 次.*pending/);
  limiter.write('dns timeout', 'new episode');
  assert.equal(lines.at(-1), 'new episode');
});

test('日志缓存有界，时钟回拨仍能汇总，error 和状态变化不合并', () => {
  const lines = [];
  let time = 1000;
  const limiter = createLogLimiter(line => lines.push(line), { now: () => time, maxKeys: 2 });
  limiter.write('a', 'first'); limiter.write('a', 'repeat');
  limiter.write('b', 'second'); limiter.write('c', 'third');
  assert.match(lines[2], /重复 1 次/);
  time = 0; limiter.write('b', 'clock rollback');
  assert.match(lines.at(-1), /clock rollback/);
  assert.equal(kernelWarningKey('level=error msg="interface not found"'), null);
  assert.equal(kernelWarningKey('level=warning msg="[TUN] default interface changed by monitor, => WLAN"'), null);
  assert.notEqual(kernelWarningKey('level=warning msg="dial error: REALITY authentication failed"'),
    kernelWarningKey('level=warning msg="dial error: context canceled"'));
});

test('真实日志接线合并跨 stdout/stderr 的重复警告，退出汇总，error 原样保留', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egcc-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end: () => child.emit('exit', 0, null) };
  const lines = [];
  const core = createNetCore({ binary: '/test', homeDir: dir, configPath: path.join(dir, 'config.yaml'),
    spawn: () => child, portOwner: async () => null,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ version: 'test' }) }),
    logger: line => lines.push(line),
  });
  await core.start();
  const warning = 'level=warning msg="dial error: context canceled"\n';
  child.stdout.emit('data', warning.slice(0, 10));
  child.stdout.emit('data', warning.slice(10));
  child.stderr.emit('data', warning.repeat(1000));
  child.stderr.emit('data', 'level=error msg="default interface lost"\n');
  assert.equal(lines.filter(line => line.startsWith('kernel:') && line.includes('context canceled')).length, 1);
  assert.ok(lines.some(line => line.includes('level=error')));
  await core.stop();
  assert.ok(lines.some(line => /重复 1000 次/.test(line)));
});
