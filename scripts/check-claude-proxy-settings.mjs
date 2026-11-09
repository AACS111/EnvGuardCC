import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeProxySettings } from './claude-proxy-settings.mjs';

const proxy = 'http://127.0.0.1:39080';
const oldProxy = 'http://127.0.0.1:7890';
const read = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t, settings) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-claude-proxy-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const configDir = path.join(stateDir, 'claude');
  const file = path.join(configDir, 'settings.json');
  const backup = path.join(stateDir, 'claude-proxy-backup.json');
  if (settings !== undefined) {
    await mkdir(configDir);
    await writeFile(file, JSON.stringify(settings));
  }
  return { file, backup, stateDir, configDir, manager: createClaudeProxySettings({ stateDir, configDir }) };
}

test('同步现有代理变量并保留其它配置，退出后恢复原值', async t => {
  const settings = { model: 'custom', env: { HTTP_PROXY: oldProxy, HTTPS_PROXY: oldProxy, all_proxy: 'socks5://127.0.0.1:1080', NO_PROXY: 'localhost', CUSTOM_VALUE: 'keep' } };
  const f = await fixture(t, settings);
  await f.manager.apply(proxy);
  assert.deepEqual(await read(f.file), { ...settings, env: { ...settings.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, all_proxy: proxy } });
  assert.equal((await read(f.backup)).entries.HTTP_PROXY.value, oldProxy);
  await f.manager.restore();
  assert.deepEqual(await read(f.file), settings);
  await assert.rejects(readFile(f.backup), { code: 'ENOENT' });
});

test('首次创建配置后可恢复为无文件，并保留期间新增的设置', async t => {
  const f = await fixture(t);
  await f.manager.apply(proxy);
  assert.equal((await read(f.file)).env.HTTPS_PROXY, proxy);
  await f.manager.restore();
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  await f.manager.apply(proxy);
  const settings = await read(f.file);
  settings.env.CUSTOM_VALUE = 'new';
  await writeFile(f.file, JSON.stringify(settings));
  await f.manager.restore();
  assert.deepEqual(await read(f.file), { env: { CUSTOM_VALUE: 'new' } });
});

test('重启恢复旧备份并支持端口变化及连续调用', async t => {
  const settings = { env: { HTTP_PROXY: oldProxy } };
  const f = await fixture(t, settings);
  await f.manager.apply(proxy);
  const recovered = createClaudeProxySettings(f);
  const nextProxy = 'http://egcc:test-secret@127.0.0.1:39880';
  await Promise.all([recovered.apply(nextProxy), recovered.apply(nextProxy)]);
  assert.equal((await read(f.file)).env.HTTPS_PROXY, nextProxy);
  await recovered.restore();
  assert.deepEqual(await read(f.file), settings);
});

test('恢复时保留用户手动修改、删除的代理及其它设置', async t => {
  const f = await fixture(t, { env: { HTTP_PROXY: oldProxy, HTTPS_PROXY: oldProxy } });
  await f.manager.apply(proxy);
  const settings = await read(f.file);
  settings.env.HTTP_PROXY = 'http://127.0.0.1:9999';
  delete settings.env.HTTPS_PROXY;
  settings.model = 'new-model';
  await writeFile(f.file, JSON.stringify(settings));
  await f.manager.restore();
  assert.deepEqual(await read(f.file), settings);
});

test('切换端口时写配置中断，仍能从上次生效的代理恢复原值', async t => {
  const original = { env: { HTTP_PROXY: oldProxy } };
  const f = await fixture(t, original);
  await f.manager.apply(proxy);
  const backup = await read(f.backup);
  // 模拟新备份已落盘，但 settings.json 的原子替换尚未完成。
  backup.entries.HTTP_PROXY.applied = [proxy, 'http://127.0.0.1:39880'];
  backup.entries.HTTPS_PROXY.applied = [proxy, 'http://127.0.0.1:39880'];
  await writeFile(f.backup, JSON.stringify(backup));
  const recovered = createClaudeProxySettings(f);
  await recovered.restore();
  assert.deepEqual(await read(f.file), original);
});

test('配置没有 env 时退出恢复原结构', async t => {
  const f = await fixture(t, { model: 'custom' });
  await f.manager.apply(proxy);
  await f.manager.restore();
  assert.deepEqual(await read(f.file), { model: 'custom' });
});

test('无效配置和备份不会被覆盖', async t => {
  const f = await fixture(t, { env: [] });
  await assert.rejects(f.manager.apply(proxy), /env/);
  assert.deepEqual(await read(f.file), { env: [] });
  await writeFile(f.file, '{broken');
  await assert.rejects(f.manager.apply(proxy), SyntaxError);
  assert.equal(await readFile(f.file, 'utf8'), '{broken');
  await writeFile(f.file, '{}');
  await f.manager.apply(proxy);
  await writeFile(f.backup, '{"version":999}');
  await assert.rejects(f.manager.restore(), /备份无效/);
  assert.equal((await read(f.file)).env.HTTP_PROXY, proxy);
  assert.equal((await read(f.backup)).version, 999);
});

test('异常退出后配置被用户删除时不重建旧配置', async t => {
  const f = await fixture(t, { env: { HTTP_PROXY: oldProxy } });
  await f.manager.apply(proxy);
  await rm(f.file);
  await f.manager.restore();
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  await assert.rejects(readFile(f.backup), { code: 'ENOENT' });
});

test('拒绝非 EGCC 本机代理地址', async t => {
  const f = await fixture(t, {});
  await assert.rejects(f.manager.apply('http://example.com:39080'), /本机/);
  assert.deepEqual(await read(f.file), {});
});
