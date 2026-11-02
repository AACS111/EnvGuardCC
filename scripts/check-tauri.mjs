import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProtocol } from '../desktop/protocol.mjs';
import { createShutdown } from '../desktop/lifecycle.mjs';
import { startSite, closeServer } from '../desktop/site.mjs';

test('双向通信保留请求关联、错误和断线语义', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const messages = createInterface({ input: output });
  const protocol = createProtocol({ input, output, dispatch: method => { if (method === 'fail') throw new Error('denied'); return { method }; } });
  let line = once(messages, 'line');
  input.write('{malformed}\n' + JSON.stringify({ type: 'request', id: 7, method: 'fail' }) + '\n');
  assert.deepEqual(JSON.parse((await line)[0]), { type: 'response', id: 7, error: 'denied' });
  line = once(messages, 'line');
  const result = protocol.request('get_login');
  const outgoing = JSON.parse((await line)[0]);
  input.write(JSON.stringify({ type: 'response', id: outgoing.id, result: false }) + '\n');
  assert.equal(await result, false);
  const interrupted = protocol.request('confirm_reset');
  const rejected = assert.rejects(interrupted, /连接已断开/);
  input.end(); await rejected;
  messages.close();
});

test('原生操作超时不会留下挂起请求', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const protocol = createProtocol({ input, output, timeout: 20, dispatch: () => null });
  await assert.rejects(protocol.request('get_login'), /超时/);
  protocol.close();
});

test('恢复失败保持服务可用，重试成功后才关闭；并发退出只恢复一次', async () => {
  const calls = []; let fail = true;
  const stop = createShutdown({ restore: async () => { calls.push('restore'); if (fail) throw new Error('permission denied'); }, closeServices: async () => { calls.push('close'); } });
  await assert.rejects(stop(), /permission denied/);
  assert.deepEqual(calls, ['restore']);
  fail = false;
  await Promise.all([stop(), stop()]);
  assert.deepEqual(calls, ['restore', 'restore', 'close']);
});

test('本地页面服务注入随机后台端口并限制请求方法和目录访问', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'envguardcc-site-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'index.html'), '<html><head></head><body>test</body></html>');
  await mkdir(path.join(directory, 'en')); await writeFile(path.join(directory, 'en/index.html'), '<head></head>');
  const site = await startSite(directory, { helper: 41001, gateway: 41002 }, 0);
  t.after(() => closeServer(site));
  const url = `http://127.0.0.1:${site.address().port}`;
  assert.match(await (await fetch(url)).text(), /__CHECKCC_PORTS__=\{"helper":41001,"gateway":41002\}/);
  assert.equal((await fetch(url + '/en/')).status, 200);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(url + '/missing')).status, 404);
  const outside = await mkdtemp(path.join(tmpdir(), 'envguardcc-site-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(outside, path.join(directory, 'outside'), 'junction');
  assert.equal((await fetch(url + '/outside/secret.txt')).status, 403);
});

async function backendFixture(t) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await mkdtemp(path.join(tmpdir(), 'envguardcc-backend-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ['desktop', 'scripts', 'src/detection', 'src/i18n', 'src/regions']) await cp(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
  await mkdir(path.join(fixture, 'out')); await writeFile(path.join(fixture, 'out/index.html'), '<head></head>');
  const userData = path.join(fixture, 'data'); await mkdir(userData);
  await writeFile(path.join(userData, 'desktop-settings.json'), JSON.stringify({ autoStartProtection: false, openAtLogin: false, minimizeToTray: true }));
  return { fixture, userData };
}

function launchBackend(t, { fixture, userData }, overrides = {}) {
  const child = spawn(process.execPath, [path.join(fixture, 'desktop/backend.mjs')], { env: { ...process.env, CHECKCC_DESKTOP_SITE_PORT: '0', CHECKCC_DESKTOP_DEV_URL: '', CHECKCC_DESKTOP_USER_DATA: userData, CHECKCC_STATE_DIR: path.join(userData, 'state'), ...overrides }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) { const exit = once(child, 'exit'); const timeout = setTimeout(() => child.kill(), 5000); await exit; clearTimeout(timeout); } });
  const lines = createInterface({ input: child.stdout });
  const responses = new Map(); let id = 0, login = false;
  const ready = new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`后台提前退出 (${code}): ${stderr}`)));
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'request') {
        if (message.method === 'set_login') login = message.params.enabled;
        child.stdin.write(JSON.stringify({ type: 'response', id: message.id, result: { openAtLogin: login, status: null } }) + '\n');
      } else if (message.type === 'ready') resolve(message);
      else if (message.type === 'response') { const waiter = responses.get(message.id); if (waiter) { responses.delete(message.id); if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result); } }
    });
  });
  const call = (method, params) => new Promise((resolve, reject) => { const key = ++id; responses.set(key, { resolve, reject }); child.stdin.write(JSON.stringify({ type: 'request', id: key, method, params }) + '\n'); });
  return { child, ready, call };
}

test('真实后台就绪、旧设置兼容、参数拒绝和退出后端口释放', { timeout: 25000 }, async t => {
  const fixture = await backendFixture(t);
  const { userData } = fixture;
  const { child, ready, call } = launchBackend(t, fixture);
  const started = await ready;
  const settings = await call('getSettings');
  assert.equal(settings.autoStartProtection, false);
  assert.equal(settings.canOpenAtLogin, true);
  assert.equal(Object.hasOwn(settings, 'minimizeToTray'), false);
  await assert.rejects(call('updateSettings', { executable: 'bad' }), /无效/);
  await assert.rejects(call('trash', { path: 'bad' }), /不支持/);
  assert.equal((await call('updateSettings', { openAtLogin: true })).openAtLogin, true);
  assert.equal(JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'))).openAtLogin, true);
  assert.equal((await fetch(started.url)).status, 200);
  assert.deepEqual(await call('shutdown'), { restored: true });
  const exited = once(child, 'exit'); child.stdin.end();
  assert.equal((await exited)[0], 0);
  await assert.rejects(fetch(`http://127.0.0.1:${started.ports.helper}/session`));
  await assert.rejects(fetch(`http://127.0.0.1:${started.ports.gateway}/__checkcc/status`));
  await assert.rejects(fetch(started.url));
});

test('启动期间退出也必须等待初始化完成再恢复，不遗留迟创建的服务', { timeout: 25000 }, async t => {
  const { child, ready, call } = launchBackend(t, await backendFixture(t));
  const stopping = call('shutdown');
  const started = await ready;
  assert.deepEqual(await stopping, { restored: true });
  const exited = once(child, 'exit'); child.stdin.end();
  assert.equal((await exited)[0], 0);
  await assert.rejects(fetch(started.url));
  await assert.rejects(fetch(`http://127.0.0.1:${started.ports.helper}/session`));
});

test('宿主管道异常断开时后台自行恢复并释放所有监听器', { timeout: 25000 }, async t => {
  const { child, ready } = launchBackend(t, await backendFixture(t));
  const started = await ready;
  const exited = once(child, 'exit'); child.stdin.end();
  assert.equal((await exited)[0], 1);
  await assert.rejects(fetch(started.url));
  await assert.rejects(fetch(`http://127.0.0.1:${started.ports.gateway}/__checkcc/status`));
});

test('页面端口冲突明确失败，不接管或关闭原来实例', { timeout: 25000 }, async t => {
  const original = launchBackend(t, await backendFixture(t));
  const started = await original.ready;
  const failed = launchBackend(t, await backendFixture(t), { CHECKCC_DESKTOP_SITE_PORT: new URL(started.url).port });
  const exited = once(failed.child, 'exit');
  await assert.rejects(failed.ready, /EADDRINUSE/);
  assert.equal((await exited)[0], 1);
  assert.equal((await fetch(started.url)).status, 200);
  assert.equal((await original.call('getSettings')).autoStartProtection, false);
  await original.call('shutdown'); original.child.stdin.end();
});
