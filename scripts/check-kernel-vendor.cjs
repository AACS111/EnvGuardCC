/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner uses CommonJS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('内核绑定拒绝未固定清单，复用校验缓存并修复损坏文件', async () => {
  const { ensureKernel, sha256 } = await import('./net-core/vendor.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'checkcc-vendor-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const binary = Buffer.from('test-kernel');
  let downloads = 0;
  const options = { manifestPath, key: 'test', outputDir: directory, download: async () => { downloads++; return binary; } };
  const manifest = { version: 'v1.0.0', platforms: { test: { file: 'kernel', url: 'https://example.com/kernel', sha256: null } } };
  try {
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(ensureKernel(options), /未固定/);
    assert.equal(downloads, 0);
    manifest.platforms.test.sha256 = sha256(binary);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await ensureKernel(options);
    await ensureKernel(options);
    assert.equal(downloads, 1);
    await writeFile(path.join(directory, 'kernel'), 'corrupt');
    await ensureKernel(options);
    assert.equal(downloads, 2);
    assert.deepEqual(await readFile(path.join(directory, 'kernel')), binary);
    await rm(path.join(directory, 'kernel'));
    await assert.rejects(ensureKernel({ ...options, download: async () => Buffer.from('wrong') }), /校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('并发启停串行完成，已停止内核不会被健康检查重新启动', async () => {
  const { createNetCore } = await import('./net-core.mjs');
  const { EventEmitter } = require('node:events');
  let count = 0;
  let active = 0;
  let maximum = 0;
  const core = createNetCore({ binary: '/test/kernel', homeDir: await mkdtemp(path.join(tmpdir(), 'checkcc-core-')), configPath: path.join(tmpdir(), 'test.yaml'), apiPort: 49123,
    portOwner: async () => null,
    spawn: () => {
      const child = new EventEmitter(); child.pid = ++count;
      active++; maximum = Math.max(maximum, active);
      child.kill = () => { setTimeout(() => { active--; child.emit('exit', 0, 'SIGTERM'); }, 5); return true; };
      return child;
    },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: 'test' }) }),
  });
  await Promise.all([core.start(), core.start(), core.restart(), core.stop()]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(core.state().pid, null);
  assert.equal(await core.health(), false);
  assert.equal(active, 0);
});

test('停止无法确认退出时保留 PID 并报告失败', async () => {
  const { createNetCore } = await import('./net-core.mjs');
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.pid = 12345;
  child.kill = () => false;
  const core = createNetCore({ binary: '/test/kernel', homeDir: await mkdtemp(path.join(tmpdir(), 'checkcc-core-')), configPath: path.join(tmpdir(), 'test.yaml'), apiPort: 49124,
    portOwner: async () => null, spawn: () => child,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: 'test' }) }),
  });
  await core.start();
  await assert.rejects(core.stop(), /未确认退出/);
  assert.equal(core.state().pid, 12345);
  child.emit('exit', 0, 'SIGKILL');
  await core.stop();
  assert.equal(core.state().pid, null);
});

test('宿主无法清除未知端口占用时拒绝报告停止成功', async () => {
  const { createKernelHost, HOST_TOKEN_HEADER } = await import('./net-core/host.mjs');
  const host = createKernelHost({ token: 'a'.repeat(32), binary: '/test/mihomo', stateDir: '/test/state', port: 0,
    ports: { portOwner: async () => 123, processCommandLine: async () => '/other/clash', processName: async () => 'clash' },
  });
  const { url } = await host.listen();
  try {
    const response = await fetch(url + '/kernel', { method: 'POST', headers: { [HOST_TOKEN_HEADER]: host.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).ok, false);
  } finally { await new Promise(resolve => { host.server.closeAllConnections(); host.server.close(resolve); }); }
});

test('宿主管理模式也必须验证 TUN，API 就绪不能冒充隧道接管', async () => {
  const { createNetCore } = await import('./net-core.mjs');
  const core = createNetCore({ binary:'/test/kernel',homeDir:'/private/tmp',configPath:'/private/tmp/test.yaml',manageProcess:false,verifyTunnel:true,
    lookup:async()=>({address:'203.0.113.1'}),
    fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({version:'test'})}),
  });
  await assert.rejects(core.start(),/隧道未接管/);
  assert.equal(core.state().running,false);
  await core.stop();
});
