import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { startTrafficLayer } from './traffic-layer.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'guardcc-flclash-flow-'));
  const previous = { state: process.env.CHECKCC_STATE_DIR, app: process.env.CHECKCC_FLCLASH_DIR, profile: process.env.CHECKCC_FLCLASH_PROFILE };
  process.env.CHECKCC_STATE_DIR = path.join(dir, 'state'); process.env.CHECKCC_FLCLASH_DIR = dir; delete process.env.CHECKCC_FLCLASH_PROFILE;
  await mkdir(path.join(dir, 'profiles')); await mkdir(path.join(dir, 'state'));
  const original = 'proxies: [{name: node, type: http, server: example.invalid, port: 443}]\nproxy-groups: [{name: Overseas, type: select, proxies: [node]}]\nrules: [MATCH,Overseas]\n';
  // Keep MATCH as one YAML scalar.
  const raw = original.replace('[MATCH,Overseas]', '["MATCH,Overseas"]');
  const file = path.join(dir, 'profiles/9001.yaml');
  await writeFile(file, raw);
  await writeFile(path.join(dir, 'shared_preferences.json'), JSON.stringify({ 'flutter.config': '{"currentProfileId":"9001"}' }));
  const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
  const listenPort = await freePort(), returnPort = await freePort();
  await writeFile(path.join(dir, 'state/traffic-settings.json'), JSON.stringify({ listenPort, upstreamBasePort: returnPort, defaultPolicy: 'Overseas', allOverseas: true, sites: { domains: ['example.com'] } }));
  let activeProxies = {}, activeRules = [], requests = 0, layer, inbound, invalidRules = false;
  const controller = http.createServer((request, response) => {
    requests++; assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bearer local-fixture');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/version' ? { version: 'fixture' } : request.url === '/rules' ? invalidRules ? {} : { rules: activeRules } : { proxies: activeProxies }));
  });
  await new Promise(r => controller.listen(0, '127.0.0.1', r));
  const runtimeConfig = `external-controller: 127.0.0.1:${controller.address().port}\nsecret: local-fixture\n`;
  await writeFile(path.join(dir, 'config.yaml'), runtimeConfig);
  t.after(async () => {
    await layer?.close(); if (inbound?.listening) await new Promise(r => inbound.close(r));
    controller.closeAllConnections(); await new Promise(r => controller.close(r));
    for (const [name, value] of [['CHECKCC_STATE_DIR', previous.state], ['CHECKCC_FLCLASH_DIR', previous.app], ['CHECKCC_FLCLASH_PROFILE', previous.profile]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const flow = await import(`./traffic-config.mjs?workflow-test=${encodeURIComponent(dir)}`);
  const prepared = await flow.prepareTrafficConfig(); layer = await startTrafficLayer(path.join(dir, 'state/traffic-layer.json'));
  await flow.applyTrafficConfig();
  const generated = await readFile(file, 'utf8');
  const activate = async () => {
    inbound = net.createServer(socket => socket.end()); await new Promise(r => inbound.listen(returnPort, '127.0.0.1', r));
    activeProxies = Object.fromEntries(prepared.routes.map(route => [`EnvGuardCC-${route.id}`, {}]));
    activeRules = prepared.routes.map(route => ({ proxy: `EnvGuardCC-${route.id}` }));
  };
  const deactivate = async () => {
    activeProxies = {}; activeRules = [];
    if (inbound?.listening) await new Promise(r => inbound.close(r));
  };
  const setRuntimeResidue = extra => writeFile(path.join(dir, 'config.yaml'), runtimeConfig + extra);
  return { dir, file, raw, flow, prepared, generated, activate, deactivate, setRuntimeResidue, setInvalidRules: value => { invalidRules = value; }, requests: () => requests };
}

test('重载前保留入口；未知外部修改保留备份且不覆盖', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const { flow, file, raw, generated } = f;
  assert.equal((await flow.trafficStatus()).runtimeVerified, false);
  await f.activate();
  assert.equal((await flow.trafficStatus()).runtimeVerified, true);
  await writeFile(file, 'externally changed');
  await assert.rejects(flow.restoreTrafficConfig(), { code: 'FLCLASH_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), 'externally changed');
  const conflict = await flow.trafficStatus();
  assert.equal(await readFile(path.join(conflict.recovery.backupDir, 'current-profile.yaml'), 'utf8'), 'externally changed');
  await writeFile(file, generated);
  await assert.rejects(flow.restoreTrafficConfig(), { code: 'FLCLASH_RELOAD_REQUIRED' });
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal((await flow.entryStatus(f.prepared)).kind, 'checkcc-traffic-layer');
  const pending = JSON.parse(await readFile(path.join(f.dir, 'state/traffic-layer.json'), 'utf8'));
  assert.equal(pending.applied, true); assert.equal(pending.phase, 'restore_pending');
  await f.deactivate();
  await flow.restoreTrafficConfig();
  assert.equal((await flow.trafficStatus()).applied, false);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.ok(f.requests() > 0);
});

test('用户已替换配置时保留新节点，确认内核重载后才能退出', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await f.activate();
  const current = parse(f.raw); current.proxies[0].port = 8443;
  const changed = stringify(current) + '# user comment\n';
  await writeFile(f.file, changed);
  await assert.rejects(f.flow.restoreTrafficConfig(), { code: 'FLCLASH_RELOAD_REQUIRED' });
  assert.equal(await readFile(f.file, 'utf8'), changed);
  assert.equal((await f.flow.trafficStatus()).recovery.kind, 'reload');
  await f.deactivate();
  await f.flow.restoreTrafficConfig();
  assert.equal(await readFile(f.file, 'utf8'), changed);
  assert.equal((await f.flow.trafficStatus()).applied, false);
});

test('保留节点修改的恢复需要明确操作，写回后等内核重载', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await f.activate();
  const current = parse(f.generated); current.proxies[0].port = 8443;
  current.rules.push('DOMAIN-SUFFIX,user.example,DIRECT');
  const changed = stringify(current).replace('port: 8443', 'port: 8443 # user comment');
  await writeFile(f.file, changed);
  await assert.rejects(f.flow.restoreTrafficConfig(), { code: 'FLCLASH_MERGE_AVAILABLE' });
  const status = await f.flow.trafficStatus();
  assert.equal(status.recovery.kind, 'merge');
  assert.ok(status.recovery.changes.some(change => change.path.includes('port') && change.before === 443 && change.after === 8443));
  assert.equal(await readFile(path.join(status.recovery.backupDir, 'current-profile.yaml'), 'utf8'), changed);
  await assert.rejects(f.flow.restoreTrafficConfig({ mode: 'preserve', expectedHash: 'stale' }), { code: 'FLCLASH_CONFLICT' });
  assert.equal(await readFile(f.file, 'utf8'), changed);
  await assert.rejects(f.flow.restoreTrafficConfig({ mode: 'preserve', expectedHash: status.recovery.fingerprint }), { code: 'FLCLASH_RELOAD_REQUIRED' });
  const candidate = await readFile(f.file, 'utf8');
  assert.match(candidate, /# user comment/);
  assert.equal(parse(candidate).proxies[0].port, 8443);
  assert.ok(parse(candidate).rules.includes('DOMAIN-SUFFIX,user.example,DIRECT'));
  assert.doesNotMatch(candidate, /EnvGuardCC-|checkcc-return-/);
  await f.deactivate(); await f.flow.restoreTrafficConfig();
  assert.equal((await f.flow.trafficStatus()).applied, false);
});

test('联动项被改写时只能显式选择原备份，并保留当前配置副本', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await f.activate();
  const current = parse(f.generated); current.proxies.at(-1).port = 9999;
  const changed = stringify(current); await writeFile(f.file, changed);
  await assert.rejects(f.flow.restoreTrafficConfig(), { code: 'FLCLASH_CONFLICT' });
  const status = await f.flow.trafficStatus();
  assert.equal(status.recovery.kind, 'conflict'); assert.equal(status.recovery.originalValid, true);
  await assert.rejects(f.flow.restoreTrafficConfig({ mode: 'preserve', expectedHash: status.recovery.fingerprint }), { code: 'FLCLASH_CONFLICT' });
  assert.equal(await readFile(f.file, 'utf8'), changed);
  await assert.rejects(f.flow.restoreTrafficConfig({ mode: 'original', expectedHash: status.recovery.fingerprint }), { code: 'FLCLASH_RELOAD_REQUIRED' });
  assert.equal(await readFile(path.join(status.recovery.backupDir, 'current-profile.yaml'), 'utf8'), changed);
  assert.equal(await readFile(f.file, 'utf8'), f.raw);
  await f.deactivate(); await f.flow.restoreTrafficConfig();
});

test('控制器状态不完整时不报告恢复成功，也不关闭入口', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); f.setInvalidRules(true);
  await assert.rejects(f.flow.restoreTrafficConfig(), { code: 'FLCLASH_VERIFY_REQUIRED' });
  assert.equal((await f.flow.entryStatus(f.prepared)).kind, 'checkcc-traffic-layer');
  assert.equal((await f.flow.trafficStatus()).applied, true);
  f.setInvalidRules(false); await f.flow.restoreTrafficConfig();
});

test('运行配置仍指向被改名的本机入口时，等待 FlClash 重载', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const port = new URL(f.prepared.routes[0].upstream).port;
  await f.setRuntimeResidue(`listeners:\n  - name: renamed\n    listen: 127.0.0.1\n    port: ${port}\n`);
  await assert.rejects(f.flow.restoreTrafficConfig(), { code: 'FLCLASH_RELOAD_REQUIRED' });
  assert.equal((await f.flow.entryStatus(f.prepared)).kind, 'checkcc-traffic-layer');
  await f.setRuntimeResidue(''); await f.flow.restoreTrafficConfig();
});

test('本机助手把恢复选择、重载和退出串成可重试的流程', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await f.activate();
  const current = parse(f.generated); current.proxies[0].port = 8443;
  await writeFile(f.file, stringify(current));
  const { startRepairHelper } = await import(`./local-repair.mjs?recovery-test=${encodeURIComponent(f.dir)}`);
  const helper = await startRepairHelper(0);
  t.after(async () => {
    if (helper.server?.listening) { helper.server.closeAllConnections(); await new Promise(resolve => helper.server.close(resolve)); }
  });
  const headers = { Origin: 'http://127.0.0.1:3030', 'X-CheckCC-Client': 'repair-ui' };
  const session = await (await fetch(helper.url + '/session?tokenOnly=1', { headers })).json();
  const send = (url, value) => fetch(helper.url + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token }, body: JSON.stringify(value) });
  let response = await send('/shutdown', { stopServer: true });
  assert.equal(response.status, 500); assert.equal((await response.json()).code, 'FLCLASH_MERGE_AVAILABLE');
  const status = await (await fetch(helper.url + '/traffic', { headers })).json();
  response = await send('/traffic', { action: 'restore-preserving-changes', fingerprint: status.recovery.fingerprint });
  assert.equal(response.status, 202); assert.equal((await response.json()).phase, 'restore_pending');
  response = await send('/shutdown', { stopServer: true });
  assert.equal(response.status, 500); assert.equal((await response.json()).code, 'FLCLASH_RELOAD_REQUIRED');
  assert.equal((await f.flow.entryStatus(f.prepared)).kind, 'checkcc-traffic-layer');
  await f.deactivate();
  response = await send('/shutdown', { stopServer: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).restored, true);
  assert.equal(parse(await readFile(f.file, 'utf8')).proxies[0].port, 8443);
});

test('配置未重载时从 FlClash 偏好读取控制器', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guardcc-flclash-prefs-'));
  const previous = process.env.CHECKCC_FLCLASH_DIR;
  process.env.CHECKCC_FLCLASH_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHECKCC_FLCLASH_DIR; else process.env.CHECKCC_FLCLASH_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const secret = 'a'.repeat(32);
  await writeFile(path.join(dir, 'shared_preferences.json'), JSON.stringify({ 'flutter.config': JSON.stringify({ currentProfileId: '9001', patchClashConfig: { 'external-controller': '127.0.0.1:19090', secret } }) }));
  await writeFile(path.join(dir, 'config.yaml'), 'external-controller: ""\nsecret: ""\n');
  const { flclashController } = await import('./flclash-runtime.mjs');
  const controller = await flclashController();
  assert.equal(controller.url.href, 'http://127.0.0.1:19090/');
  assert.equal(controller.secret, secret);
});
