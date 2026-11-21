// 生成配置必须经过真实宿主校验与启动入口；所有系统操作均使用隔离替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { buildKernelConfig, strictKernelConfig } from './net-core/config.mjs';
import { createKernelHost, readHostConfig, HOST_TOKEN_HEADER } from './net-core/host.mjs';

function generated(egressMode = 'rule') {
  return buildKernelConfig({
    proxies: [{ name: 'test-node', type: 'ss', server: '203.0.113.10', port: 443, cipher: 'aes-128-gcm', password: 'fixture' }],
    selected: 'test-node', secret: 'fixture-controller-secret-'.repeat(3), egressMode,
  });
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), 'checkcc-host-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'net-core'));
  return { dir, file: path.join(dir, 'net-core/config.yaml') };
}

test('宿主接受包含两个测速开关的全部模式及严格模式生成配置', async t => {
  const { dir, file } = await fixture(t);
  for (const config of [...['rule', 'global', 'direct'].map(generated), strictKernelConfig(generated())]) {
    await writeFile(file, stringify(config));
    const accepted = await readHostConfig(dir, file);
    assert.equal(accepted['unified-delay'], true);
    assert.equal(accepted['tcp-concurrent'], true);
    assert.deepEqual(accepted, parse(stringify(config)));
  }
});

test('宿主测速字段只接受布尔值，仍拒绝外部文件、脚本和 provider', async t => {
  const { dir, file } = await fixture(t);
  for (const field of ['unified-delay', 'tcp-concurrent']) {
    for (const value of [true, false]) {
      await writeFile(file, stringify({ ...generated(), [field]: value }));
      assert.equal((await readHostConfig(dir, file))[field], value);
    }
    for (const value of ['true', 1, null, {}, []]) {
      await writeFile(file, stringify({ ...generated(), [field]: value }));
      await assert.rejects(readHostConfig(dir, file), /布尔/);
    }
  }
  for (const field of ['external-ui', 'external-ui-url', 'script', 'proxy-providers', 'rule-providers']) {
    await writeFile(file, stringify({ ...generated(), [field]: '/outside' }));
    await assert.rejects(readHostConfig(dir, file), /配置字段/);
  }
});

test('宿主只允许 profile 禁用缓存中的选择器', async t => {
  const { dir, file } = await fixture(t);
  const profile = { 'store-selected': false };
  await writeFile(file, stringify({ ...generated(), profile }));
  assert.deepEqual((await readHostConfig(dir, file)).profile, profile);
  for (const invalid of [null, [], {}, { 'store-selected': true }, { ...profile, 'store-fake-ip': true }]) {
    await writeFile(file, stringify({ ...generated(), profile: invalid }));
    await assert.rejects(readHostConfig(dir, file), /profile 仅允许/);
  }
});

test('生成配置通过真实 HTTP 宿主启动入口，测速开关原样进入私有快照', async t => {
  const { dir, file } = await fixture(t);
  let starts = 0;
  const token = 'fixture-host-token-'.repeat(3);
  const host = createKernelHost({
    token, binary: '/fixture/mihomo', stateDir: dir, port: 0, requiresAdmin: false,
    ports: { portOwner: async () => null },
    firewall: { restore: async () => {}, status: () => ({ armed: false }), arm: async () => {} },
    claudeGuard: { load: async () => {}, reconcile: async () => {}, status: () => ({}) },
    systemIpv6: { restore: async () => {} },
    createCore: options => {
      let running = false;
      return {
        start: async () => {
          const snapshot = parse(await readFile(options.configPath, 'utf8'));
          assert.equal(snapshot['unified-delay'], true);
          assert.equal(snapshot['tcp-concurrent'], true);
          assert.notEqual(options.configPath, file);
          starts++;
          running = true;
        },
        stop: async () => { running = false; },
        state: () => ({ running }),
      };
    },
  });
  const { url } = await host.listen();
  t.after(() => host.close());
  for (const strict of [false, true]) {
    await writeFile(file, stringify(strict ? strictKernelConfig(generated()) : generated()));
    const response = await fetch(`${url}/kernel`, {
      method: 'POST', headers: { [HOST_TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', configPath: file, strict }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.running, true);
  }
  assert.equal(starts, 2);
});
