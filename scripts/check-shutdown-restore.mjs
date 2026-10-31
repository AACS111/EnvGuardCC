import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProtectionService } from './protection-service.mjs';
import { ProtectionSession } from './protection-session.mjs';
import { stopManagedProcess } from './managed-process.mjs';
import { EnvironmentRuntime } from './environment-runtime.mjs';
import { assertCurrentHelper, shutdownHelper, HELPER_PROTOCOL } from './helper-connection.mjs';
import http from 'node:http';

async function fixture(t, { rawPolicy = null, runtimeFailure = false } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-shutdown-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const policyFile = path.join(stateDir, 'environment-policy.json');
  const profileFile = path.join(stateDir, 'region-profile.json');
  const originalProfile = '{ "target": {"language": "en-US", "locale": "en-US"} }\n';
  await writeFile(profileFile, originalProfile);
  if (rawPolicy !== null) await writeFile(policyFile, rawPolicy);
  const calls = [];
  let zone = 'Original Zone';
  const runtime = {
    policy: { languages: ['en-US'] }, enabled: true, clients: new Map(), load: async () => {},
    restore: async () => { calls.push('runtime-restore'); if (runtimeFailure) throw new Error('page disconnected'); return { results: [] }; },
    close: async () => { calls.push('runtime-close'); return { results: [{ state: 'restored' }] }; },
    apply: async () => { calls.push('runtime-apply'); if (runtimeFailure) throw new Error('page unavailable'); return { results: [] }; },
  };
  const service = createProtectionService({ stateDir, runtime, browserCloak: { close: async () => calls.push('sync-stop') },
    currentZone: async () => zone, setZone: async next => { calls.push('timezone'); zone = next; },
    gatewayRequest: async (endpoint, value) => { calls.push(value ? `gateway-${value.enabled}` : 'gateway-status'); return { cloak: { enabled: false } }; },
  });
  const baseline = await service.snapshot();
  await writeFile(policyFile, '{"languages":["ko-KR"]}');
  await writeFile(profileFile, '{"target":{"language":"ko-KR"}}');
  zone = 'Adapted Zone';
  return { service, baseline, calls, runtime, policyFile, profileFile, originalProfile, zone: () => zone };
}

test('退出恢复保留配置文件原文，并关闭受控进程而不重新应用保护', async t => {
  const rawPolicy = '{\n  "languages": ["en-US"]\n}\n';
  const f = await fixture(t, { rawPolicy });
  assert.deepEqual(await f.service.restore(f.baseline, 'http://127.0.0.1:3030', { shutdown: true }), []);
  assert.equal(await readFile(f.policyFile, 'utf8'), rawPolicy);
  assert.equal(await readFile(f.profileFile, 'utf8'), f.originalProfile);
  if (process.platform === 'win32') assert.equal(f.zone(), 'Original Zone');
  assert.ok(f.calls.includes('runtime-close'));
  assert.ok(!f.calls.includes('runtime-apply'));
  assert.equal(f.calls.at(-1), 'gateway-false');
});

test('原本不存在的环境配置文件在退出恢复时删除', async t => {
  const f = await fixture(t);
  assert.equal(f.baseline.policyFile, null);
  await f.service.restore(f.baseline, 'http://127.0.0.1:3030', { shutdown: true });
  await assert.rejects(readFile(f.policyFile), { code: 'ENOENT' });
});

test('页面恢复或重连失败不阻止原始配置、时区与网关继续恢复', async t => {
  const rawPolicy = '{ "languages": ["en-US"] }\n';
  const f = await fixture(t, { rawPolicy, runtimeFailure: true });
  const issues = await f.service.restore(f.baseline, 'http://127.0.0.1:3030');
  assert.equal(issues.length, 2);
  assert.equal(await readFile(f.policyFile, 'utf8'), rawPolicy);
  assert.equal(await readFile(f.profileFile, 'utf8'), f.originalProfile);
  if (process.platform === 'win32') assert.equal(f.zone(), 'Original Zone');
  assert.equal(f.calls.at(-1), 'gateway-false');
});

test('退出恢复失败保留快照，重试仍沿用原始值及退出选项', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-shutdown-session-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  let fail = true;
  const options = [];
  const session = new ProtectionSession({ stateDir, snapshot: async () => ({ original: 'saved' }), detect: async () => ({ ip: '1.2.3.4', language: 'en-US', locale: 'en-US' }), apply: async () => [], test: async () => ({ state: 'passed' }), restore: async (baseline, _origin, context) => { assert.equal(baseline.original, 'saved'); options.push(context); return fail ? ['temporary error'] : []; } });
  await session.start('http://127.0.0.1:3030');
  assert.equal((await session.stop({ shutdown: true })).phase, 'restore_failed');
  assert.equal(JSON.parse(await readFile(session.file, 'utf8')).baseline.original, 'saved');
  fail = false;
  assert.equal((await session.stop({ shutdown: true })).phase, 'idle');
  await assert.rejects(readFile(session.file), { code: 'ENOENT' });
  assert.deepEqual(options, [{ shutdown: true }, { shutdown: true }]);
});

test('退出等待本次创建的进程终止，临时启动参数和环境随进程释放', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'spawn');
  await stopManagedProcess(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await stopManagedProcess(child);
});

test('旧助手即使有环境接口也不能被当作支持退出恢复的新版本', () => {
  const legacy = { token: 'a'.repeat(64), environmentScripts: 1, browserCloak: 1 };
  assert.throws(() => assertCurrentHelper(legacy), /版本过旧/);
  assert.doesNotThrow(() => assertCurrentHelper({ ...legacy, helperProtocol: HELPER_PROTOCOL, shutdown: 1, desktopLauncher: 1 }));
});

test('退出连接先检查能力；旧版本不发送不支持的退出请求，恢复失败不冒充成功', async t => {
  let current = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/session') return response.end(JSON.stringify({ token: 'a'.repeat(64), ...(current ? { helperProtocol: HELPER_PROTOCOL, shutdown: 1, desktopLauncher: 1 } : {}) }));
    response.writeHead(500); response.end(JSON.stringify({ error: 'original restore error' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(shutdownHelper(url, 'http://localhost:3000'), /版本过旧/);
  assert.deepEqual(requests, ['/session']);
  current = true;
  await assert.rejects(shutdownHelper(url, 'http://localhost:3000'), /original restore error/);
  assert.equal(requests.at(-1), '/shutdown');
});

test('复用现有助手只恢复配置，不关闭它的监听端口', async t => {
  const requests = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/session') return response.end(JSON.stringify({
      token: 'a'.repeat(64), helperProtocol: HELPER_PROTOCOL, shutdown: 1, desktopLauncher: 1, environmentScripts: 1, browserCloak: 1,
    }));
    if (request.url === '/shutdown' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.end(JSON.stringify({ restored: true }));
      });
      return;
    }
    response.writeHead(404); response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { startRepairHelper } = await import('./local-repair.mjs');
  const helper = await startRepairHelper(server.address().port);
  assert.equal(helper.server, null);
  await helper.closeRuntime();
  assert.deepEqual(requests, [{ stopServer: false }]);
  assert.equal(server.listening, true);
});

test('真实助手可复用退出后仍接受 POST，并能再次完成恢复', { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-helper-reuse-'));
  const previousState = process.env.CHECKCC_STATE_DIR;
  process.env.CHECKCC_STATE_DIR = stateDir;
  let helper;
  t.after(async () => {
    if (helper?.server?.listening) {
      helper.server.closeAllConnections();
      await new Promise(resolve => helper.server.close(resolve));
    }
    if (previousState === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = previousState;
    await rm(stateDir, { recursive: true, force: true });
  });
  let startRepairHelper;
  try {
    // A query string isolates this module instance's state and listener from the mock reuse test.
    ({ startRepairHelper } = await import('./local-repair.mjs?real-reuse-test'));
  } finally {
    if (previousState === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = previousState;
  }
  helper = await startRepairHelper(0);
  const headers = { Origin: 'http://localhost:3000', 'X-CheckCC-Client': 'repair-ui', 'Content-Type': 'application/json' };
  const session = await (await fetch(`${helper.url}/session`, { headers })).json();
  const restore = async token => {
    const response = await fetch(`${helper.url}/shutdown`, {
      method: 'POST', headers: { ...headers, 'X-CheckCC-Token': token }, body: JSON.stringify({ stopServer: false }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await restore(session.token), { status: 200, body: { restored: true } });
  assert.equal(helper.server.listening, true);
  const desktop = await (await fetch(`${helper.url}/claude-desktop`, { headers })).json();
  assert.equal(desktop.state, 'idle');
  assert.equal(desktop.pid, null);
  const post = await fetch(`${helper.url}/protection`, {
    method: 'POST', headers: { ...headers, 'X-CheckCC-Token': session.token }, body: JSON.stringify({ action: 'observe' }),
  });
  assert.equal(post.status, 200);
  const secondSession = await (await fetch(`${helper.url}/session`, { headers })).json();
  assert.match(secondSession.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(await restore(secondSession.token), { status: 200, body: { restored: true } });
  assert.equal(helper.server.listening, true);
});

test('失效脚本注册不阻止撤销语言和接口覆盖，仍必须核对原始值', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-stale-script-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const runtime = new EnvironmentRuntime({ stateDir, networkProxy: null });
  const methods = [];
  let nativeMatches = true;
  const baseline = { languages: ['en-US'], locale: 'en-US' };
  const client = { send: async (method, params) => {
    methods.push(method);
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') throw new Error('Script not found');
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'next' };
    if (method === 'Runtime.evaluate' && params.expression.startsWith('({languages:')) return { result: { value: { ...baseline, protected: !nativeMatches } } };
    return {};
  } };
  runtime.clients.set('web', { kind: 'web', tasks: new Set(), client, origin: 'http://localhost:3000', sessions: new Map([['page', { script: 'expired', baseline }]]) });
  assert.equal((await runtime.restore()).results[0].state, 'restored');
  assert.ok(methods.includes('Emulation.setUserAgentOverride'));
  assert.ok(methods.includes('Emulation.setLocaleOverride'));
  nativeMatches = false;
  assert.equal((await runtime.restore()).results[0].state, 'unverified');
});
