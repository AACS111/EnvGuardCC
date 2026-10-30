import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopLauncher } from './desktop-launcher.mjs';
import { createDesktopGateway } from './desktop-gateway.mjs';
import { DesktopLocale } from './desktop-locale.mjs';
import { HELPER_PROTOCOL } from './helper-connection.mjs';
import { ClassicLevel } from 'classic-level';

async function fixture(t, respond) {
  const sockets = new Set(), received = [];
  const upstream = http.createServer((request, response) => { received.push({ url: request.url, headers: request.headers }); response.end('via-upstream'); });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.on('connect', (request, socket) => {
    received.push({ url: request.url, headers: request.headers });
    socket.on('error', () => {});
    if (respond) { respond(socket); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', bytes => socket.write(bytes));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = { url: new URL(`http://user:secret@127.0.0.1:${upstream.address().port}`) };
  const relay = createDesktopGateway({ proxy });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); });
  return { relay, received, port: relay.server.address().port, proxy };
}
async function tunnel(port, authority) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const [response] = await once(socket, 'data');
  return { socket, response: response.toString() };
}

test('桌面 HTTPS 隧道经过选定上游，原始字节不变，状态不泄漏代理凭证', async t => {
  const { relay, received, port } = await fixture(t);
  const { socket, response } = await tunnel(port, 'claude.ai:443');
  t.after(() => socket.destroy());
  assert.match(response, /200 Connection Established/);
  const payload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x03, 1, 2, 3]);
  const reply = once(socket, 'data'); socket.write(payload);
  assert.deepEqual((await reply)[0], payload);
  assert.equal(received[0].url, 'claude.ai:443');
  assert.equal(received[0].headers['proxy-authorization'], `Basic ${Buffer.from('user:secret').toString('base64')}`);
  assert.equal(relay.snapshot().tunnels, 1);
  assert.doesNotMatch(JSON.stringify(relay.snapshot()), /user|secret|payload/);
  const plain = await tunnel(port, 'claude.ai:80');
  t.after(() => plain.socket.destroy());
  assert.match(plain.response, /200/);
  assert.equal(received[1].url, 'claude.ai:80');
});
test('上游拒绝隧道时失败关闭，不回退直连；本机目标被拒绝', async t => {
  const { relay, received, port } = await fixture(t, socket => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
  const failed = await tunnel(port, 'claude.ai:443');
  t.after(() => failed.socket.destroy());
  assert.match(failed.response, /502/);
  assert.equal(relay.snapshot().failed, 1);
  const denied = await tunnel(port, '127.0.0.1:3030');
  t.after(() => denied.socket.destroy());
  assert.match(denied.response, /400/);
  assert.equal(received.length, 1);
});
test('普通 HTTP 请求也使用同一代理路径', async t => {
  const { relay, port, received } = await fixture(t, socket => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', request => {
      assert.match(request.toString(), /^GET \/resource HTTP\/1.1/);
      assert.doesNotMatch(request.toString(), /Proxy-Authorization/i);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  const result = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: 'http://claude.ai/resource' }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(result, 200);
  assert.equal(received[0].url, 'claude.ai:80');
  assert.equal(relay.snapshot().requests, 1);
});

async function launcherFixture(t, spawnBehavior) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-desktop-'));
  await mkdir(path.join(stateDir, 'resources'));
  await writeFile(path.join(stateDir, 'resources/ko-KR.json'), '{}');
  let options, args, starts = 0;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, unref() {}, kill() { this.signalCode = 'SIGTERM'; this.emit('exit', null, 'SIGTERM'); return true; } });
  const launcher = new DesktopLauncher({ stateDir, findExecutable: async () => path.join(stateDir, 'Claude.exe'), resolveProxy: () => null, startProcess: (_exe, argv, config) => {
    starts++; options = config; args = argv;
    queueMicrotask(() => spawnBehavior ? spawnBehavior(child) : child.emit('spawn'));
    return child;
  } });
  t.after(async () => { await launcher.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { launcher, child, stateDir, config: () => ({ options, args, starts }) };
}

test('桌面语言跟随出口，关闭时只还原语言，保留客户端其它新设置', async t => {
  const { launcher, stateDir, config } = await launcherFixture(t);
  const profile = new DesktopLocale(stateDir);
  await mkdir(path.dirname(profile.file), { recursive: true });
  await writeFile(profile.file, JSON.stringify({ locale: 'zh-Hans', theme: 'light' }));
  await writeFile(profile.preferences, JSON.stringify({ intl: { accept_languages: 'zh-CN,zh', another: true } }));
  assert.equal((await launcher.launch({ locale: 'ko-KR' })).locale, 'ko-KR');
  assert.ok(config().args.includes('--lang=ko-KR'));
  assert.equal(JSON.parse(await readFile(profile.file, 'utf8')).locale, 'ko-KR');
  assert.equal(JSON.parse(await readFile(profile.preferences, 'utf8')).intl.accept_languages, 'ko-KR,ko,en');
  await writeFile(profile.file, JSON.stringify({ locale: 'ko-KR', theme: 'dark', newSetting: true }));
  await launcher.close();
  assert.deepEqual(JSON.parse(await readFile(profile.file, 'utf8')), { locale: 'zh-Hans', theme: 'dark', newSetting: true });
  assert.deepEqual(JSON.parse(await readFile(profile.preferences, 'utf8')), { intl: { accept_languages: 'zh-CN,zh', another: true } });
  await assert.rejects(readFile(profile.backup), { code: 'ENOENT' });
});

test('语言切换保留第一次的原始备份，原本无语言字段时恢复为自动选择', async t => {
  const { stateDir } = await launcherFixture(t);
  const profile = new DesktopLocale(stateDir);
  await profile.apply('ko-KR');
  await profile.apply('en-US');
  const recovered = new DesktopLocale(stateDir);
  await recovered.restore();
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(profile.file, 'utf8')), 'locale'));
});

test('登录页的 spa:locale 跟随出口，并精确还原且保留其它网页数据', async t => {
  const { stateDir } = await launcherFixture(t);
  const profile = new DesktopLocale(stateDir);
  const key = Buffer.concat([Buffer.from('_https://claude.ai\0'), Buffer.from([1]), Buffer.from('spa:locale')]);
  const original = Buffer.concat([Buffer.from([1]), Buffer.from('zh-Hans')]);
  let db = new ClassicLevel(profile.storage, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  await db.put(key, original);
  await db.put(Buffer.from('unrelated-preference'), Buffer.from('keep-original'));
  await db.close();
  await profile.apply('ko-KR');
  db = new ClassicLevel(profile.storage, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  assert.deepEqual(await db.get(key), Buffer.concat([Buffer.from([1]), Buffer.from('ko-KR')]));
  await db.put(Buffer.from('another-new-setting'), Buffer.from('keep-new'));
  await db.close();
  await profile.restore();
  db = new ClassicLevel(profile.storage, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  assert.deepEqual(await db.get(key), original);
  assert.equal((await db.get(Buffer.from('unrelated-preference'))).toString(), 'keep-original');
  assert.equal((await db.get(Buffer.from('another-new-setting'))).toString(), 'keep-new');
  await db.close();
});

test('受控客户端未能关闭时保留语言备份，不把仍运行的临时语言当作已恢复', async t => {
  const { launcher, child, stateDir } = await launcherFixture(t);
  const profile = new DesktopLocale(stateDir);
  await launcher.launch({ locale: 'ko-KR' });
  const kill = child.kill;
  child.kill = () => { throw new Error('close denied'); };
  await assert.rejects(launcher.close(), /close denied/);
  assert.equal(JSON.parse(await readFile(profile.file, 'utf8')).locale, 'ko-KR');
  assert.equal(JSON.parse(await readFile(profile.backup, 'utf8')).hadLocale, false);
  child.kill = kill;
  await launcher.close();
});
test('并发点击只启动一个桌面进程，代理只注入子进程，尚无流量不得算连通', async t => {
  const { launcher, config, child } = await launcherFixture(t);
  const original = process.env.HTTPS_PROXY;
  const [first, second] = await Promise.all([launcher.launch(), launcher.launch()]);
  assert.equal(config().starts, 1);
  assert.equal(first.state, 'running'); assert.equal(second.pid, first.pid);
  assert.equal(config().args.length, 1);
  assert.match(config().args[0], /^--user-data-dir=/);
  assert.deepEqual(config().options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(config().options.env.HTTPS_PROXY, first.gateway.url);
  assert.equal(process.env.HTTPS_PROXY, original);
  assert.equal(first.gateway.tunnels, 0);
  assert.equal(first.gateway.requests, 0);
  child.exitCode = 0; child.emit('exit', 0);
  assert.equal(launcher.snapshot().state, 'exited');
});
test('启动错误和单实例转交退出均不得冒充托管运行', async t => {
  const failed = await launcherFixture(t, child => child.emit('error', Object.assign(new Error('spawn denied'), { code: 'EACCES' })));
  await assert.rejects(failed.launcher.launch(), /spawn denied/);
  assert.equal(failed.launcher.snapshot().state, 'failed');
  const exited = await launcherFixture(t, child => { child.emit('spawn'); child.exitCode = 0; child.emit('exit', 0); });
  await assert.rejects(exited.launcher.launch(), /启动进程已退出/);
  assert.equal(exited.launcher.snapshot().state, 'failed');
});

test('客户端拒绝网络参数时保留真实原因，异常退出不误报已有实例', async t => {
  const rejected = await launcherFixture(t, child => {
    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('Claude: refusing to start — a debugging or network-override switch is present on the command line.'));
    child.exitCode = 1; child.emit('exit', 1);
  });
  await assert.rejects(rejected.launcher.launch(), /（1）。客户端拒绝调试或网络覆盖启动参数/);
  const crashed = await launcherFixture(t, child => { child.emit('spawn'); child.exitCode = 2; child.emit('exit', 2); });
  await assert.rejects(crashed.launcher.launch(), /（2）。请检查 Claude 客户端日志/);
});

test('本机启动接口要求会话认证和已开启保护，保护关闭时不能绕过按钮启动', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-desktop-api-'));
  const originalState = process.env.CHECKCC_STATE_DIR, originalProxy = process.env.CHECKCC_PROXY;
  process.env.CHECKCC_STATE_DIR = stateDir;
  process.env.CHECKCC_PROXY = 'direct';
  const { startRepairHelper } = await import('./local-repair.mjs');
  const helper = await startRepairHelper(0);
  t.after(async () => {
    await helper.closeRuntime();
    helper.server.closeAllConnections();
    await new Promise(resolve => helper.server.close(resolve));
    if (originalState === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = originalState;
    if (originalProxy === undefined) delete process.env.CHECKCC_PROXY; else process.env.CHECKCC_PROXY = originalProxy;
    await rm(stateDir, { recursive: true, force: true });
  });
  const headers = { Origin: 'http://127.0.0.1:3030', 'X-CheckCC-Client': 'repair-ui' };
  const sessionResponse = await fetch(`${helper.url}/session`, { headers });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.helperProtocol, HELPER_PROTOCOL);
  assert.equal(session.shutdown, 1);
  assert.equal(session.desktopLauncher, 1);
  const unauthorized = await fetch(`${helper.url}/claude-desktop`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'launch' }) });
  assert.equal(unauthorized.status, 403);
  const disabled = await fetch(`${helper.url}/claude-desktop`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token }, body: JSON.stringify({ action: 'launch' }) });
  assert.equal(disabled.status, 409);
  assert.match((await disabled.json()).error, /请先开启保护/);
  const status = await (await fetch(`${helper.url}/claude-desktop`, { headers })).json();
  assert.equal(status.state, 'idle');
  assert.equal(status.gateway, null);
  const unauthorizedShutdown = await fetch(`${helper.url}/shutdown`, { method: 'POST', headers });
  assert.equal(unauthorizedShutdown.status, 403);
  const shutdown = await fetch(`${helper.url}/shutdown`, { method: 'POST', headers: { ...headers, 'X-CheckCC-Token': session.token } });
  assert.equal(shutdown.status, 200);
  assert.deepEqual(await shutdown.json(), { restored: true });
  const repeated = await fetch(`${helper.url}/shutdown`, { method: 'POST', headers: { ...headers, 'X-CheckCC-Token': session.token } });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { restored: true });
});
