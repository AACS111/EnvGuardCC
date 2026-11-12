// 只使用模拟内核及本机临时 HTTP 服务，不安装服务、不修改网卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernelHost, HOST_TOKEN_HEADER } from './net-core/host.mjs';
import { createClaudeGuard } from './net-core/claude-guard.mjs';

test('慢速布防不阻塞健康检查，旧心跳不能撤销新的阻断状态', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'egcc-host-guard-'));
  await mkdir(path.join(directory, 'net-core'));
  await writeFile(path.join(directory, 'net-core', 'config.yaml'), 'secret: 0123456789abcdef0123456789abcdef\nmode: rule\n');
  let finish, entered, running = false, released = 0;
  const entering = new Promise(resolve => { entered = resolve; });
  let cached = { supported: true, desired: 'released', armed: false };
  const host = createKernelHost({ token: 'test-guard-cache-token-123456789', binary: 'unused', stateDir: directory, port: 0,
    ports: { portOwner: async () => null },
    claudeGuard: {
      supported: true, load: async () => {}, reconcile: async () => cached, snapshot: () => cached,
      status: () => { throw new Error('health must not query PowerShell'); },
      arm: async () => { entered(); await new Promise(resolve => { finish = resolve; }); cached = { supported: true, desired: 'armed', armed: true }; return cached; },
      release: async () => { released++; return cached; },
    },
    createCore: () => ({ start: async () => { running = true; }, stop: async () => { running = false; }, state: () => ({ running }) }),
  });
  const { url } = await host.listen();
  const headers = { 'Content-Type': 'application/json', [HOST_TOKEN_HEADER]: host.token };
  const call = body => fetch(`${url}/kernel`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    await call({ action: 'start' });
    const arming = call({ action: 'claude-guard', op: 'arm' });
    await entering;
    const health = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(1000) });
    assert.equal(health.status, 200);
    const heartbeat = await call({ action: 'heartbeat', claudeGuardDesired: 'released' });
    assert.equal(heartbeat.status, 200);
    finish();
    assert.equal((await arming).status, 200);
    await call({ action: 'heartbeat', claudeGuardDesired: 'released' });
    assert.equal(released, 0);
    assert.equal((await (await fetch(`${url}/health`, { headers })).json()).claudeGuard.armed, true);
  } finally { finish?.(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('心跳过期保留存活或未知应用的内核，旧实例不得续租，确认应用退出才回收', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'egcc-host-lease-'));
  await mkdir(path.join(directory, 'net-core'));
  await writeFile(path.join(directory, 'net-core', 'config.yaml'), 'secret: 0123456789abcdef0123456789abcdef\nmode: rule\n');
  let alive = true, running = false;
  const host = createKernelHost({ token: 'test-owner-lease-token-123456789', binary: 'unused', stateDir: directory, port: 0,
    claudeGuard: createClaudeGuard({ platform: 'linux', hostsPath: null }),
    ports: { portOwner: async () => null }, leaseTimeoutMs: 30, ownerAlive: () => alive,
    createCore: () => ({ start: async () => { running = true; }, stop: async () => { running = false; }, state: () => ({ running }) }),
  });
  const { url } = await host.listen();
  const call = body => fetch(`${url}/kernel`, { method: 'POST', headers: { 'Content-Type': 'application/json', [HOST_TOKEN_HEADER]: host.token }, body: JSON.stringify(body) });
  try {
    const owner = { pid: process.pid, id: 'current-instance' };
    assert.equal((await call({ action: 'start', leaseOwner: owner })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(running, true);
    assert.equal((await call({ action: 'heartbeat', leaseOwner: { ...owner, id: 'old-instance' } })).status, 409);
    alive = null;
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(running, true, '无法确认应用退出时保留内核');
    alive = false;
    for (let i = 0; i < 30 && running; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(running, false);
    const stopped = await call({ action: 'heartbeat', leaseOwner: owner });
    assert.equal((await stopped.json()).code, 'KERNEL_NOT_RUNNING');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('停止等待在途 IPv6 禁用结束，再串行恢复原设置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'egcc-host-ipv6-'));
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const host = createKernelHost({ token: 'test-ipv6-queue-token-123456789', binary: 'unused', stateDir: directory, port: 0,
    claudeGuard: createClaudeGuard({ platform: 'linux', hostsPath: null }),
    ports: { portOwner: async () => null },
    systemIpv6: {
      disable: async () => { entered(); await new Promise(resolve => { release = resolve; }); calls.push('disabled'); return { changed: true, previous: 'On' }; },
      restore: async () => { calls.push('restored'); return true; },
    },
  });
  const { url } = await host.listen();
  const call = body => fetch(`${url}/kernel`, { method: 'POST', headers: { 'Content-Type': 'application/json', [HOST_TOKEN_HEADER]: host.token }, body: JSON.stringify(body) });
  try {
    const disabling = call({ action: 'ipv6', enabled: false });
    await started;
    let stopped = false;
    const stopping = call({ action: 'stop' }).then(response => { stopped = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(stopped, false);
    release();
    assert.equal((await disabling).status, 200);
    assert.equal((await stopping).status, 200);
    assert.deepEqual(calls, ['disabled', 'restored']);
  } finally { release?.(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});
