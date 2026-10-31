import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMacProxy, systemProxy, systemProxyStatus, validateProxySettings } from './gateway-proxy.mjs';
import { readSystemTimezone, setSystemTimezone, validIanaTimezone } from './system-timezone.mjs';
import { flclashDirectory, currentFlclashProfile, flclashController } from './flclash-runtime.mjs';
import { DesktopLauncher } from './desktop-launcher.mjs';

test('Mac 静态代理、系统路由、PAC、SOCKS 和读取失败不混为直连', () => {
  const configured = parseMacProxy('<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : ::1\n HTTPSPort : 7890\n}');
  assert.equal(configured.address, 'http://[::1]:7890');
  assert.equal(parseMacProxy('<dictionary> {\n FTPPassive : 1\n}').state, 'disabled');
  for (const value of ['ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable', 'SOCKSEnable']) {
    const output = `<dictionary> {\n ${value} : 1\n}`;
    assert.equal(parseMacProxy(output).state, 'unsupported');
    assert.throws(() => systemProxy({ platform: 'darwin', run: () => output }));
  }
  assert.equal(systemProxyStatus({ platform: 'darwin', run: () => { throw new Error('failed'); } }).state, 'failed');
  assert.throws(() => systemProxy({ platform: 'darwin', run: () => { throw new Error('failed'); } }));
  assert.throws(() => validateProxySettings({ mode: 'manual', address: 'socks5://localhost:7890' }));
  assert.throws(() => validateProxySettings({ mode: 'manual', address: 'http://private:credential@localhost:7890' }));
});

test('Mac 时区读取无提权，写入仅执行固定命令；取消和复核失败均报告失败', async () => {
  assert.equal(await readSystemTimezone({ platform: 'darwin', resolve: async () => '/var/db/timezone/zoneinfo/Asia/Shanghai' }), 'Asia/Shanghai');
  assert.equal(validIanaTimezone('Asia/Shanghai;touch /tmp/bad'), false);
  let calls = 0;
  const run = async (file, args) => { calls++; assert.equal(file, '/usr/bin/osascript'); assert.equal(args.at(-1), 'Asia/Tokyo'); assert.match(args[1], /quoted form of/); return { stdout: '' }; };
  assert.equal(await setSystemTimezone('Asia/Tokyo', { platform: 'darwin', checkZone: async () => {}, run, read: async () => 'Asia/Tokyo' }), 'Asia/Tokyo');
  await assert.rejects(setSystemTimezone('Asia/Tokyo', { platform: 'darwin', checkZone: async () => {}, run, read: async () => 'Asia/Shanghai' }), /复核/);
  await assert.rejects(setSystemTimezone('Asia/Tokyo', { platform: 'darwin', checkZone: async () => {}, run: async () => { throw new Error('User canceled (-128)'); } }), /取消/);
  await assert.rejects(setSystemTimezone('../bad', { platform: 'darwin', run }), /无效/);
  assert.equal(calls, 2);
});

test('Mac FlClash 读取系统偏好的精确配置 ID，控制端口必须本机且带认证', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guardcc-flclash-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = '370409826729070592';
  await mkdir(path.join(dir, 'profiles'));
  await writeFile(path.join(dir, 'profiles', `${id}.yaml`), 'proxies: []');
  const profile = await currentFlclashProfile({ directory: dir, platform: 'darwin', env: {}, run: async (file, args) => {
    assert.equal(file, '/usr/bin/defaults'); assert.deepEqual(args, ['read', 'com.follow.clash', 'flutter.config']);
    return { stdout: `{"currentProfileId":${id}}` };
  } });
  assert.equal(profile, path.join(dir, 'profiles', `${id}.yaml`));
  assert.equal(flclashDirectory({ platform: 'darwin', env: {}, home: '/test-user' }), '/test-user/Library/Application Support/com.follow.clash');
  await writeFile(path.join(dir, 'config.yaml'), 'external-controller: 0.0.0.0:9090\nsecret: local-test-only');
  await assert.rejects(flclashController(dir), /本机/);
  await writeFile(path.join(dir, 'config.yaml'), 'external-controller: 127.0.0.1:9090');
  await assert.rejects(flclashController(dir), /认证/);
});

test('Mac 普通打开不修改用户资料或注入代理，也不声明托管成功', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'guardcc-ordinary-launch-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  let opened = false;
  const launcher = new DesktopLauncher({ stateDir: state, platform: 'darwin', findExecutable: async () => '/Applications/Claude.app/Contents/MacOS/Claude', openApplication: async (file, args) => {
    assert.equal(file, '/usr/bin/open'); assert.deepEqual(args, ['-a', '/Applications/Claude.app']); opened = true;
  }, resolveProxy: () => { throw new Error('ordinary launch must not inject a proxy'); } });
  const result = await launcher.launch({ locale: 'ja-JP' });
  assert.equal(opened, true); assert.equal(result.state, 'opened'); assert.equal(result.mode, 'standard'); assert.equal(result.pid, null); assert.equal(result.gateway, null);
  await launcher.close();
});

test('macOS 切换时区时短暂缺失的文件会等待回读，不丢失原始备份依据', async () => {
  let reads = 0;
  const zone = await readSystemTimezone({ platform: 'darwin', resolve: async () => {
    if (reads++ === 0) throw Object.assign(new Error('transient rename'), { code: 'ENOENT' });
    return '/var/db/timezone/zoneinfo/Asia/Shanghai';
  } });
  assert.equal(zone, 'Asia/Shanghai'); assert.equal(reads, 2);
});
