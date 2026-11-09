import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionLog, CONNECTION_RETENTION_MS, CONNECTION_MAX_ENTRIES, CONNECTION_MAX_BYTES } from './net-core/connection-log.mjs';

const base = Date.parse('2026-11-08T00:00:00Z');
const connection = (id, extra = {}) => ({ id, metadata: { host: `${id}.example.com`, destinationIP: '203.0.113.10', destinationPort: '443' }, chains: ['node-a', 'AUTO-PROXY'], rule: 'Match', upload: 10, download: 20, start: new Date(base).toISOString(), ...extra });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'egcc-connections-'));
  let at = base;
  const log = await createConnectionLog({ stateDir: dir, now: () => at, ...options });
  t.after(async () => { await log.stop(); await rm(dir, { recursive: true, force: true }); });
  return { dir, file: path.join(dir, 'net-core-connections.json'), log, advance: ms => { at += ms; } };
}
const finish = async f => { f.advance(1000); await f.log.sample([]); f.advance(1000); await f.log.sample([]); };

test('每秒采样按 id 合并，活动只放内存，两次缺失收尾，字节不倒退', async t => {
  const f = await fixture(t);
  await f.log.sample([connection('a')]);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  f.advance(1000);
  await f.log.sample([connection('a', { upload: 100, download: 500 })]);
  await f.log.sample([connection('a', { upload: 9, download: 10 })]);
  assert.equal((await f.log.list()).total, 1);
  f.advance(1000); await f.log.sample([]);
  assert.equal((await f.log.snapshot()).stats.active, 1);
  await f.log.sample([connection('a')]);
  const before = await f.log.list();
  assert.equal(before.items[0].download, 500);
  assert.equal(before.items[0].startedAt, new Date(base).toISOString());
  await finish(f);
  const after = await f.log.list();
  assert.deepEqual(after.stats, { active: 0, ended: 1, total: 1 });
  assert.equal(after.items[0].endedAt, new Date(base + 3000).toISOString());
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.records.length, 1);
  const restarted = await createConnectionLog({ stateDir: f.dir, now: () => base + 5000 });
  assert.equal((await restarted.list()).items[0].download, 500);
  await restarted.stop();
});

test('白名单防止正文、query、凭证和进程路径进入内存/API/磁盘', async t => {
  const f = await fixture(t);
  await f.log.sample([connection('private', {
    metadata: { host: 'https://api.anthropic.com/v1/messages?token=SECRET_QUERY', destinationIP: '203.0.113.5', destinationPort: 443, processPath: '/secret/process', process: 'SECRET_PROCESS', url: '/v1/messages?token=SECRET_URL' },
    chains: ['node?token=SECRET_CHAIN', 'CLAUDE-PIN'], rule: 'Domain', rulePayload: 'anthropic.com?token=SECRET_RULE',
    body: 'SECRET_BODY', headers: { authorization: 'SECRET_AUTH' }, url: '/?token=SECRET_OUTER',
  })]);
  const current = (await f.log.list()).items[0];
  assert.equal(current.host, 'api.anthropic.com');
  assert.equal(current.isClaude, true);
  assert.equal(current.viaExit, true);
  assert.deepEqual(current.chains, ['node', 'CLAUDE-PIN']);
  assert.doesNotMatch(JSON.stringify(await f.log.snapshot()), /SECRET_|processPath|authorization|\/v1\//);
  await finish(f);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /SECRET_|processPath|authorization|\/v1\//);
  await f.log.sample([connection('local', { chains: ['ENVGUARD-LOCAL-DIRECT'] }), connection('unknown', { chains: [] }), connection('blocked', { chains: ['REJECT'] })]);
  assert.equal((await f.log.list({ host: 'local' })).items[0].viaExit, false);
  assert.equal((await f.log.list({ host: 'unknown' })).items[0].viaExit, null);
  assert.equal((await f.log.list({ host: 'blocked' })).items[0].route, 'blocked');
});

test('48 小时过期自动修剪，启动也修剪旧数据与隐私字段', async t => {
  const f = await fixture(t);
  await f.log.sample([connection('old')]); await finish(f);
  f.advance(CONNECTION_RETENTION_MS + 1);
  assert.equal((await f.log.list()).total, 0);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  const recent = { ...connection('recent'), host: 'recent.example.com', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 1000).toISOString(), query: 'SECRET_STORED', processPath: '/secret/path' };
  const old = { ...recent, id: 'expired', endedAt: new Date(base - CONNECTION_RETENTION_MS).toISOString(), startedAt: new Date(base - CONNECTION_RETENTION_MS - 1000).toISOString() };
  await writeFile(f.file, JSON.stringify({ version: 1, records: [old, recent] }));
  const restarted = await createConnectionLog({ stateDir: f.dir, now: () => base + 5000 });
  assert.equal((await restarted.list()).total, 1);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /expired|SECRET_STORED|processPath/);
  await restarted.stop();
});

test('条数和实际 JSON 体积双上限丢最旧，活动内存也受约束', async t => {
  assert.equal(CONNECTION_MAX_ENTRIES, 20000); assert.equal(CONNECTION_MAX_BYTES, 5 * 1024 * 1024);
  const f = await fixture(t, { maxEntries: 3 });
  for (let i = 0; i < 6; i++) { f.advance(1000); await f.log.sample([connection(`c${i}`, { start: new Date(base + (i + 1) * 1000).toISOString() })]); }
  await f.log.stop();
  assert.deepEqual((await f.log.list()).items.map(record => record.id), ['c5', 'c4', 'c3']);
  const tighter = await createConnectionLog({ stateDir: f.dir, now: () => base + 10000, maxEntries: 1 });
  assert.deepEqual((await tighter.list()).items.map(record => record.id), ['c5']);
  await tighter.stop();
  const small = await fixture(t, { maxBytes: 1000 });
  await small.log.sample(Array.from({ length: 10 }, (_, i) => connection(`s${i}`, { chains: ['节点'.repeat(50), 'AUTO-PROXY'] })));
  assert.ok((await small.log.list()).stats.active < 10);
  await finish(small);
  assert.ok(Buffer.byteLength(await readFile(small.file, 'utf8')) <= 1000);
  assert.equal((await readdir(small.dir)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('分页、host/Claude/出口筛选及清空删除文件', async t => {
  const f = await fixture(t);
  await f.log.sample([connection('a'), connection('b', { metadata: { host: 'api.anthropic.com' }, chains: ['node-a', 'CLAUDE-PIN'] }), connection('c', { chains: ['DIRECT'] })]);
  assert.equal((await f.log.list({ offset: 1, limit: 1 })).items.length, 1);
  assert.equal((await f.log.list({ host: 'ANTHROPIC', claude: true, viaExit: true })).total, 1);
  assert.equal((await f.log.list({ viaExit: false })).items[0].id, 'c');
  await f.log.stop();
  await f.log.clear();
  assert.equal((await f.log.list()).total, 0);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('并发写入串行化，恢复出现的 id 不产生重复记录', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => f.log.sample([connection(`parallel${i}`)])));
  await f.log.stop();
  await f.log.sample([connection('parallel0', { download: 999 })]);
  await f.log.stop();
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.records.length, 30);
  assert.equal(new Set(saved.records.map(record => record.id)).size, 30);
  assert.equal(saved.records.find(record => record.id === 'parallel0').download, 999);
  assert.equal((await readdir(f.dir)).length, 1);
});

test('清空使未完成的旧采样失效；网络失败不作为空快照结束连接', async t => {
  let resolveRead, mode = 'pending';
  const pending = new Promise(resolve => { resolveRead = resolve; });
  let intervals = 0;
  const f = await fixture(t, {
    readConnections: () => mode === 'pending' ? pending : mode === 'fail' ? Promise.reject(new Error('offline')) : null,
    scheduler: { every: (_callback, ms) => { assert.equal(ms, 1000); intervals++; return { unref() {} }; }, clear: () => { intervals--; } },
  });
  f.log.start(); f.log.start(); assert.equal(intervals, 1);
  await f.log.clear(); resolveRead([connection('late')]); await f.log.tick();
  assert.equal((await f.log.list()).total, 0);
  await f.log.sample([connection('live')]);
  mode = 'fail'; await f.log.tick(); await f.log.tick();
  assert.equal((await f.log.list()).stats.active, 1);
  mode = 'stopped'; await f.log.tick();
  assert.equal((await f.log.list()).available, false);
  await f.log.sample({ invalid: true }); await f.log.sample({ connections: 'invalid' });
  assert.equal((await f.log.list()).stats.active, 1, '无效响应也不能伪装成两个空快照');
  await f.log.stop(); assert.equal(intervals, 0);
  assert.equal((await f.log.list()).stats.ended, 1);
});

test('请求层记录 method/规范 endpoint/status/完整耗时，不存 query、动态标识或正文', async t => {
  const f = await fixture(t);
  const id = await f.log.beginRequest({ method: 'POST', endpoint: '/v1/messages?token=SECRET_QUERY', host: 'api.anthropic.com', port: 443, body: 'SECRET_BODY' });
  await f.log.sample([]); await f.log.sample([]);
  assert.equal((await f.log.list({ kind: 'request' })).items[0].endedAt, null, '连接采样不能提前结束 HTTP 请求');
  f.advance(1234);
  await f.log.finishRequest(id, { status: 201, upload: 123, download: 456, body: 'SECRET_BODY', error: 'SECRET_ERROR' });
  const record = (await f.log.list({ kind: 'request' })).items[0];
  assert.equal(record.endpoint, '/v1/messages'); assert.equal(record.method, 'POST'); assert.equal(record.status, 201);
  assert.equal(record.elapsedMs, 1234); assert.equal(record.isClaude, true); assert.equal(record.viaExit, null);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /SECRET_/);
  const model = await f.log.beginRequest({ method: 'GET', endpoint: '/v1/models/private-model-id?key=SECRET', host: 'api.anthropic.com' });
  await f.log.finishRequest(model, { status: 404 });
  assert.equal((await f.log.list({ detailId: model })).selected.endpoint, '/v1/models/:id');
  assert.doesNotMatch(await f.log.export(), /private-model-id|SECRET/);
  const late = await f.log.beginRequest({ method: 'POST', endpoint: '/arbitrary/SECRET_PATH', host: 'api.anthropic.com' });
  await f.log.clear(); await f.log.finishRequest(late, { status: 200 });
  assert.equal((await f.log.list()).total, 0, '清空后的请求结束回调不能复活旧记录');
});

test('历史回放按起止时间匹配，详情查询不受分页或筛选影响', async t => {
  const f = await fixture(t);
  await f.log.sample([connection('replay')]);
  f.advance(1000); await f.log.sample([connection('replay', { download: 999 })]);
  await finish(f);
  assert.equal((await f.log.list({ at: new Date(base - 1).toISOString() })).total, 0);
  const then = await f.log.list({ at: new Date(base + 1500).toISOString() });
  assert.equal(then.total, 1); assert.equal(then.items[0].download, 999);
  assert.equal((await f.log.list({ at: new Date(base + 2000).toISOString() })).total, 0);
  assert.equal((await f.log.list({ host: 'absent', offset: 999, detailId: 'replay' })).selected.id, 'replay');
  await assert.rejects(f.log.list({ at: 'invalid' }), /时间无效/);
});

test('导出完整筛选集合，不受分页截断，CSV 阻止公式注入且不包含敏感字段', async t => {
  const f = await fixture(t);
  await f.log.sample(Array.from({ length: 130 }, (_, i) => connection(`export${i}`, { chains: ['=HYPERLINK("private")', 'AUTO-PROXY'] })));
  const json = JSON.parse(await f.log.export({ limit: 1, offset: 100 }, 'json'));
  assert.equal(json.records.length, 130);
  assert.equal(JSON.parse(await f.log.export({ host: 'export129' })).records.length, 1);
  const csv = await f.log.export({}, 'csv');
  assert.equal(csv.split('\r\n').length, 131);
  assert.match(csv, /"'=HYPERLINK/); assert.doesNotMatch(csv, /"=HYPERLINK/);
  await assert.rejects(f.log.export({}, 'html'), /格式无效/);
});

test('记录范围持久化，仅 Claude 删除其他历史并过滤后续采样，实时快照返回全部活动连接', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 12 }, (_, i) => connection(`live${i}`));
  rows.push(connection('claude', { metadata: { host: 'api.anthropic.com' }, chains: ['node-a', 'CLAUDE-PIN'] }));
  await f.log.sample(rows);
  const live = await f.log.snapshot();
  assert.equal(live.active.length, 13); assert.equal(live.activeTotal, 13);
  await f.log.sample([]);
  assert.equal((await f.log.snapshot()).activeTotal, 0, '已经在新快照缺失的连接不能继续做活动粒子');
  await f.log.sample([]);
  await f.log.setScope('claude');
  assert.deepEqual((await f.log.list()).items.map(row => row.id), ['claude']);
  await f.log.sample(rows);
  assert.equal((await f.log.list()).total, 1);
  assert.doesNotMatch(await readFile(path.join(f.dir, 'net-core-connection-settings.json'), 'utf8'), /token|host/);
  await f.log.stop();
  const restarted = await createConnectionLog({ stateDir: f.dir, now: () => base + 10000 });
  assert.equal(restarted.settings().scope, 'claude');
  assert.equal((await restarted.list()).total, 1);
  await restarted.setScope('all'); await restarted.stop();
  await assert.rejects(f.log.setScope('invalid'), /范围无效/);
});

test('流式请求进度更新只合并元数据，清空后进度也不能复活记录', async t => {
  const f = await fixture(t);
  const id = await f.log.beginRequest({ method: 'POST', endpoint: '/v1/messages', host: 'api.anthropic.com' });
  f.advance(1000); await f.log.updateRequest(id, { status: 200, upload: 12, download: 345, body: 'SECRET_BODY' });
  const record = (await f.log.list({ detailId: id })).selected;
  assert.equal(record.status, 200); assert.equal(record.download, 345); assert.equal(record.elapsedMs, 1000); assert.equal(record.endedAt, null);
  await f.log.updateRequest(id, { upload: 1, download: 1 });
  assert.equal((await f.log.list({ detailId: id })).selected.download, 345);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  await f.log.clear(); await f.log.updateRequest(id, { download: 999 }); await f.log.finishRequest(id, { status: 200 });
  assert.equal((await f.log.list()).total, 0);
});

test('路径集合精确区分代理、直连与拦截，并支持活动/结束筛选和导出', async t => {
  const f = await fixture(t);
  await f.log.sample([
    connection('proxy', { chains: ['node-a','AUTO-PROXY'] }),
    connection('direct', { chains: ['DIRECT'] }),
    connection('blocked', { chains: ['REJECT'] }),
    connection('unknown', { chains: [] }),
  ]);
  assert.deepEqual((await f.log.list({ route: 'direct', state: 'active', kind: 'connection' })).items.map(row => row.id), ['direct']);
  assert.deepEqual((await f.log.list({ route: 'blocked', state: 'active' })).items.map(row => row.id), ['blocked']);
  await finish(f);
  assert.equal((await f.log.list({ route: 'direct', state: 'active' })).total, 0);
  assert.deepEqual((await f.log.list({ route: 'blocked', state: 'all' })).items.map(row => row.id), ['blocked']);
  assert.equal((await f.log.list({ route: 'blocked', state: 'ended' })).total, 1);
  assert.equal((await f.log.list({ route: 'blocked', state: 'active', at: new Date(base + 500).toISOString() })).total, 1);
  const exported = JSON.parse(await f.log.export({ route: 'direct', state: 'ended' }));
  assert.deepEqual(exported.records.map(row => row.id), ['direct']);
});
