import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDesktopSettings, desktopSettingsPatch, loginItemOptions, shouldHideOnClose } from './desktop-settings.mjs';

test('Windows 与 Mac 分别保存并读取真实登录自启动配置，启动保护选项跨重启保留', async t => {
  for (const platform of ['win32', 'darwin']) await t.test(platform, async t => {
    const userData = await mkdtemp(path.join(tmpdir(), 'envguardcc-desktop-settings-'));
    t.after(() => rm(userData, { recursive: true, force: true }));
    let login = false;
    const calls = [];
    const app = { isPackaged: true, getLoginItemSettings: options => { assert.deepEqual(options, loginItemOptions(platform, '/test/EnvGuardCC')); return { openAtLogin: login }; }, setLoginItemSettings: value => { calls.push(value); login = value.openAtLogin; } };
    const store = createDesktopSettings({ app, userData, platform, executable: '/test/EnvGuardCC' });
    await store.load();
    await store.update({ openAtLogin: true, autoStartProtection: true });
    assert.deepEqual(calls[0], { ...loginItemOptions(platform, '/test/EnvGuardCC'), openAtLogin: true });
    const restarted = createDesktopSettings({ app, userData, platform, executable: '/test/EnvGuardCC' });
    const settings = await restarted.load();
    assert.equal(settings.autoStartProtection, true);
    assert.equal(settings.openAtLogin, true);
    login = false; // User disables startup in the OS settings.
    assert.equal(restarted.get().openAtLogin, false);
    assert.equal(JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'))).autoStartProtection, true);
  });
});

test('开发模式不能错误注册 Electron 本身为自启动，其他桌面选项仍可配置', async t => {
  const userData = await mkdtemp(path.join(tmpdir(), 'envguardcc-desktop-dev-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const store = createDesktopSettings({ app: { isPackaged: false, setLoginItemSettings: () => assert.fail('不得注册开发版') }, userData, platform: 'darwin' });
  await store.load();
  await assert.rejects(store.update({ openAtLogin: true }), /已安装/);
  assert.equal((await store.update({ autoStartProtection: true })).autoStartProtection, true);
});

test('系统拒绝自启动时不写入虚假成功配置，配置参数仅接受固定布尔开关', async t => {
  const userData = await mkdtemp(path.join(tmpdir(), 'envguardcc-desktop-denied-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const store = createDesktopSettings({ app: { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => { throw new Error('OS denied'); } }, userData, platform: 'win32' });
  await store.load();
  await assert.rejects(store.update({ openAtLogin: true }), /OS denied/);
  assert.equal(store.get().openAtLogin, false);
  await assert.rejects(readFile(path.join(userData, 'desktop-settings.json')), { code: 'ENOENT' });
  for (const input of [{ executable: '/bin/sh' }, { openAtLogin: 'yes' }, [], null]) assert.throws(() => desktopSettingsPatch(input));
  await writeFile(path.join(userData, 'desktop-settings.json'), 'not JSON');
  assert.equal((await store.load()).autoStartProtection, false);
});

test('关闭窗口保持后台运行与真正退出分离；退出恢复期间不再隐藏窗口', () => {
  assert.equal(shouldHideOnClose({ quitting: false, stopping: false }), true);
  assert.equal(shouldHideOnClose({ quitting: false, stopping: true }), false);
  assert.equal(shouldHideOnClose({ quitting: true, stopping: false }), false);
});


test('旧预览的关闭窗口选项不会影响启动保护配置迁移', async t => {
  const userData = await mkdtemp(path.join(tmpdir(), 'envguardcc-settings-migrate-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  await writeFile(path.join(userData, 'desktop-settings.json'), JSON.stringify({ openAtLogin: false, autoStartProtection: true, minimizeToTray: false }));
  const store = createDesktopSettings({ app: { isPackaged: false }, userData });
  assert.equal((await store.load()).autoStartProtection, true);
  assert.equal(Object.hasOwn(store.get(), 'minimizeToTray'), false);
  await assert.rejects(store.update({ minimizeToTray: false }), /无效/);
});
