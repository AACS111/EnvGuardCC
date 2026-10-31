import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startTrafficLayer } from './traffic-layer.mjs';

test('Mac 联动等待 FlClash 真正重载，恢复期间保留入口且拒绝覆盖外部修改', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guardcc-flclash-flow-'));
  const previous = { state: process.env.CHECKCC_STATE_DIR, app: process.env.CHECKCC_FLCLASH_DIR, profile: process.env.CHECKCC_FLCLASH_PROFILE };
  process.env.CHECKCC_STATE_DIR = path.join(dir, 'state'); process.env.CHECKCC_FLCLASH_DIR = dir; delete process.env.CHECKCC_FLCLASH_PROFILE;
  await mkdir(path.join(dir, 'profiles')); await mkdir(path.join(dir, 'state'));
  const original = 'proxies: [{name: node, type: direct}]\nproxy-groups: [{name: Overseas, type: select, proxies: [node]}]\nrules: [MATCH,Overseas]\n';
  // Keep MATCH as one YAML scalar.
  const raw = original.replace('[MATCH,Overseas]', '["MATCH,Overseas"]');
  const file = path.join(dir, 'profiles/9001.yaml');
  await writeFile(file, raw);
  await writeFile(path.join(dir, 'shared_preferences.json'), JSON.stringify({ 'flutter.config': '{"currentProfileId":"9001"}' }));
  const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
  const listenPort = await freePort(), returnPort = await freePort();
  await writeFile(path.join(dir, 'state/traffic-settings.json'), JSON.stringify({ listenPort, upstreamBasePort: returnPort, defaultPolicy: 'Overseas', allOverseas: true, sites: { domains: ['example.com'] } }));
  let activeProxies = {}, requests = 0, layer, inbound;
  const controller = http.createServer((request, response) => {
    requests++; assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bearer local-fixture');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.url === '/version' ? { version: 'fixture' } : { proxies: activeProxies }));
  });
  await new Promise(r => controller.listen(0, '127.0.0.1', r));
  await writeFile(path.join(dir, 'config.yaml'), `external-controller: 127.0.0.1:${controller.address().port}\nsecret: local-fixture\n`);
  t.after(async () => {
    await layer?.close(); if (inbound?.listening) await new Promise(r => inbound.close(r));
    controller.closeAllConnections(); await new Promise(r => controller.close(r));
    for (const [name, value] of [['CHECKCC_STATE_DIR', previous.state], ['CHECKCC_FLCLASH_DIR', previous.app], ['CHECKCC_FLCLASH_PROFILE', previous.profile]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const flow = await import('./traffic-config.mjs?workflow-test');
  const prepared = await flow.prepareTrafficConfig(); layer = await startTrafficLayer(path.join(dir, 'state/traffic-layer.json'));
  await flow.applyTrafficConfig();
  assert.equal((await flow.trafficStatus()).runtimeVerified, false);
  inbound = net.createServer(socket => socket.end()); await new Promise(r => inbound.listen(returnPort, '127.0.0.1', r));
  activeProxies = Object.fromEntries(prepared.routes.map(route => [`EnvGuardCC-${route.id}`, {}]));
  assert.equal((await flow.trafficStatus()).runtimeVerified, true);
  const generated = await readFile(file, 'utf8');
  await writeFile(file, 'externally changed');
  await assert.rejects(flow.restoreTrafficConfig(), /其他程序修改/);
  assert.equal(await readFile(file, 'utf8'), 'externally changed');
  await writeFile(file, generated);
  await assert.rejects(flow.restoreTrafficConfig(), /原配置已写回/);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal((await flow.entryStatus(prepared)).kind, 'checkcc-traffic-layer');
  const pending = JSON.parse(await readFile(path.join(dir, 'state/traffic-layer.json'), 'utf8'));
  assert.equal(pending.applied, true); assert.equal(pending.phase, 'restore_pending');
  activeProxies = {}; await new Promise(r => inbound.close(r));
  await flow.restoreTrafficConfig();
  assert.equal((await flow.trafficStatus()).applied, false);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.ok(requests > 0);
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
