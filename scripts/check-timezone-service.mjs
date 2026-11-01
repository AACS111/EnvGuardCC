import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildTimezoneService } from './build-timezone-service.mjs';
import { applyTimezoneWithService, timezoneInstallScript, resetTimezoneServiceAuthorization } from './timezone-service.mjs';
import { setSystemTimezone } from './system-timezone.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

test('无可用服务且禁止安装时不调用服务修改', async () => {
  for (const state of ['notInstalled', 'unavailable', 'updateRequired']) {
    const calls = [];
    assert.equal(await applyTimezoneWithService('Asia/Seoul', false, {
      isSupported: () => true, allowInstall: false,
      request: async args => { calls.push(args); return { state, ok: false }; },
    }), false);
    assert.deepEqual(calls, [['status']]);
  }

});

test('服务就绪时修改与恢复均复用同一通道，失败不重复申请临时权限', async () => {
  for (const automatic of [false, true]) {
    const calls = [];
    assert.equal(await applyTimezoneWithService('Asia/Seoul', automatic, {
      isSupported: () => true, allowInstall: false,
      request: async args => { calls.push(args); return { state: 'ready', ok: true }; },
    }), true);
    assert.deepEqual(calls, [['status'], ['set', 'Asia/Seoul', String(automatic)]]);
  }
  let prompts = 0;
  await setSystemTimezone('Asia/Seoul', {
    platform: 'darwin', useService: true, service: async () => true,
    checkZone: async () => {}, read: async () => 'Asia/Seoul', readAutomatic: async () => false,
    run: async () => { prompts++; },
  });
  assert.equal(prompts, 0);
  await assert.rejects(setSystemTimezone('Asia/Seoul', {
    platform: 'darwin', useService: true, service: async () => { throw new Error('service failed'); },
    checkZone: async () => {}, run: async () => { prompts++; },
  }), /service failed/);
  assert.equal(prompts, 0);
});

test('安装脚本将含特殊字符的路径当数据，校验复制后的文件并具备失败回滚', async () => {
  const script = timezoneInstallScript("/tmp/a'; touch /tmp/not-executed; '/daemon", 'a'.repeat(64), '/tmp/service.plist', 'b'.repeat(64));
  assert.match(script, /shasum -a 256 -c -/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /old-daemon/);
  assert.match(script, /chown root:wheel/);
  // Syntax-check without executing any installer command or requiring root.
  if (process.platform !== 'win32') await exec('/bin/sh', ['-n', '-c', script]);
  assert.throws(() => timezoneInstallScript('/tmp/file', 'bad hash', '/tmp/plist', 'b'.repeat(64)), /校验值/);
});

test('原生服务真实编译；拒绝非 root 启动并校验时区输入', { skip: process.platform !== 'darwin', timeout: 120000 }, async () => {
  await buildTimezoneService();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'node_modules/.checkcc-timezone-service');
  for (const [zone, expected] of [['Asia/Seoul', 'valid'], ['../etc/passwd', 'invalid'], ['Asia/Seoul;id', 'invalid'], ['Asia/NoSuchZone', 'invalid']]) {
    assert.equal((await exec(path.join(dir, 'daemon'), ['--validate-zone', zone])).stdout.trim(), expected);
  }
  if (process.getuid() !== 0) await assert.rejects(exec(path.join(dir, 'daemon'), []), error => error.code === 1);
  await exec('/usr/bin/codesign', ['--verify', '--strict', path.join(dir, 'bridge')]);
  await exec('/usr/bin/codesign', ['--verify', '--strict', path.join(dir, 'daemon')]);
});


test('首次使用自动绑定服务；取消后后台调用不反复弹窗，显式重试可再次授权', async () => {
  resetTimezoneServiceAuthorization();
  let installed = false, installs = 0;
  const options = {
    isSupported: () => true,
    install: async () => { installs++; installed = true; },
    request: async args => args[0] === 'status' ? { state: installed ? 'ready' : 'notInstalled', ok: installed } : { state: 'ready', ok: true },
  };
  assert.equal(await applyTimezoneWithService('Asia/Seoul', false, options), true);
  assert.equal(await applyTimezoneWithService('Asia/Shanghai', true, options), true);
  assert.equal(installs, 1);
  resetTimezoneServiceAuthorization();
  installed = false; installs = 0;
  options.install = async () => { installs++; throw new Error('用户取消'); };
  await assert.rejects(applyTimezoneWithService('Asia/Seoul', false, options), /用户取消/);
  await assert.rejects(applyTimezoneWithService('Asia/Seoul', false, options), /尚未获得授权/);
  assert.equal(installs, 1);
  resetTimezoneServiceAuthorization();
  await assert.rejects(applyTimezoneWithService('Asia/Seoul', false, options), /用户取消/);
  assert.equal(installs, 2);
  resetTimezoneServiceAuthorization();
});
