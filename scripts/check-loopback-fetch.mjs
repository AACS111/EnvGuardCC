import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loopbackFetch } from './net-core/loopback-fetch.mjs';
import { createNetCore } from './net-core.mjs';

async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { url: `http://127.0.0.1:${instance.address().port}`, port: instance.address().port };
}

test('本机控制通道绕过全局 fetch 和代理，保留鉴权与 JSON 请求', async t => {
  const captured = [];
  const local = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Internet fetch must not carry control requests'); };
  t.after(() => { globalThis.fetch = original; });
  const result = await loopbackFetch(local.url + '/kernel', { method: 'POST', headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' }, body: '{"action":"heartbeat"}' });
  assert.deepEqual(await result.json(), { ok: true });
  assert.deepEqual(captured, [{ path: '/kernel', method: 'POST', auth: 'Bearer test-only', body: '{"action":"heartbeat"}' }]);
  const core = createNetCore({ binary: process.execPath, homeDir: 'unused', configPath: 'unused', apiPort: local.port, secret: 'test-only', manageProcess: false });
  assert.deepEqual(await core.request('/version'), { ok: true });
});

test('取消覆盖响应正文阶段，不能让只返回响应头的宿主挂住调用', async t => {
  const local = await server(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); res.write('{'); });
  await assert.rejects(loopbackFetch(local.url, { signal: AbortSignal.timeout(80) }), /aborted|timeout|中断/i);
  const controller = new AbortController(); controller.abort(new Error('cancelled before request'));
  await assert.rejects(loopbackFetch(local.url, { signal: controller.signal }), /cancelled before request/);
});

test('不跟随重定向，不向外网地址或 URL 凭据发送控制请求', async t => {
  let requests = 0;
  const local = await server(t, (_req, res) => { requests++; res.writeHead(302, { Location: 'https://example.com/' }); res.end(); });
  assert.equal((await loopbackFetch(local.url)).status, 302);
  assert.equal(requests, 1);
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'http://user:password@127.0.0.1/']) await assert.rejects(loopbackFetch(url), /回环地址/);
});

test('空响应与分块正文保持正确状态；连接中断不能当作成功 JSON', async t => {
  const local = await server(t, (req, res) => {
    if (req.url === '/empty') { res.writeHead(204); res.end(); }
    else if (req.url === '/broken') { res.writeHead(200); res.flushHeaders(); res.write('{'); res.destroy(); }
    else { res.writeHead(503); res.write('{"ok":'); res.end('false}'); }
  });
  const empty = await loopbackFetch(local.url + '/empty'); assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
  const failure = await loopbackFetch(local.url); assert.equal(failure.ok, false); assert.deepEqual(await failure.json(), { ok: false });
  await assert.rejects(loopbackFetch(local.url + '/broken'));
});
