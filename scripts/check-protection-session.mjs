import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtectionSession } from './protection-session.mjs';
import { createProtectionService, targetFromExit } from './protection-service.mjs';
import { BrowserCloakController } from './browser-cloak.mjs';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-protection-'));
  let settings = { timezone: 'Original', language: 'original' };
  let target = { ip: '203.0.113.44', language: 'ko-KR', locale: 'ko-KR' };
  let sequence = 0, failure = false, applyFailure = false;
  const calls = [];
  const options = { stateDir, intervalMs: 60000, snapshot: async () => structuredClone(settings), detect: async () => target,
    apply: async next => { calls.push(next.ip); if (applyFailure) throw new Error('apply failed'); settings = { timezone: 'Adapted', language: next.language }; return []; },
    restore: async baseline => { if (failure) return ['temporary restore failure']; settings = structuredClone(baseline); return []; },
    test: async () => ({ runId: String(++sequence), state: 'passed' }), ...overrides };
  const session = new ProtectionSession(options);
  t.after(async () => { failure = false; applyFailure = false; await session.stop(); await rm(stateDir, { recursive: true, force: true }); });
  return { session, options, calls, original: structuredClone(settings), settings: () => settings, target: value => target = value, failRestore: value => failure = value, failApply: value => applyFailure = value };
}
test('启动完成后才由复检执行首轮检测，关闭完成后不再执行保护测试', async t => {
  let tests = 0;
  const f = await fixture(t, { test: async () => { tests++; return { runId: 'first', state: 'passed' }; } });
  const started = await f.session.start('http://localhost:3000');
  assert.equal(started.phase, 'active'); assert.equal(started.enabled, true);
  assert.equal(started.testing, false); assert.equal(started.runId, null);
  assert.equal(started.testState, 'pending'); assert.equal(tests, 0);
  const checked = await f.session.retest();
  assert.equal(checked.runId, 'first'); assert.equal(tests, 1);
  const stopped = await f.session.stop();
  assert.equal(stopped.phase, 'idle'); assert.equal(stopped.testing, false);
  assert.equal(tests, 1);
  await assert.rejects(f.session.retest(), /先启动/);
});

test('慢检测不阻塞设置或关闭，取消后迟到结果不能覆盖已停止状态', async t => {
  let release, entered, signal;
  const ready = new Promise(resolve => { entered = resolve; });
  const slow = new Promise(resolve => { release = resolve; });
  t.after(() => release({ runId: 'late', state: 'passed' }));
  const f = await fixture(t, { test: async options => { signal = options.signal; entered(); return slow; } });
  await f.session.start('http://localhost:3000');
  const checking = f.session.retest();
  await ready;
  assert.equal(f.session.report().testing, true);
  await f.session.monitor(false, 300000);
  const stopped = await Promise.race([f.session.stop(), delay(500).then(() => { throw new Error('关闭仍被慢检测阻塞'); })]);
  assert.equal(signal.aborted, true);
  assert.equal(stopped.phase, 'idle');
  assert.equal(stopped.testing, false);
  release({ runId: 'late', state: 'passed' });
  await checking;
  assert.equal(f.session.report().phase, 'idle');
  assert.equal(f.session.report().runId, null);
});

test('自动重连检测可取消，关闭不用等待模拟任务完成', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const slow = new Promise(resolve => { release = resolve; });
  t.after(() => release({ runId: 'late-resume', state: 'passed' }));
  const f = await fixture(t, { test: async () => { entered(); return slow; } });
  await f.session.start('http://localhost:3000');
  const reconnecting = f.session.resume('http://localhost:3000');
  await ready;
  const stopped = await Promise.race([f.session.stop(), delay(500).then(() => { throw new Error('关闭仍被重连检测阻塞'); })]);
  assert.equal(stopped.phase, 'idle');
  release({ runId: 'late-resume', state: 'passed' });
  await reconnecting;
  assert.equal(f.session.report().phase, 'idle');
});

test('节点变化后自动按最新出口重新适配并继续检测，保留首次恢复备份', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000'); await f.session.retest();
  const backup = await readFile(f.session.file, 'utf8');
  const oldRun = f.session.report().runId;
  f.session.observe({ runId: oldRun, score: 70 });
  f.target({ ip: '203.0.113.40', language: 'ja-JP', locale: 'ja-JP' });
  const adapted = await f.session.retest();
  assert.equal(adapted.phase, 'active'); assert.equal(adapted.target.ip, '203.0.113.40');
  assert.equal(adapted.testState, 'passed'); assert.notEqual(adapted.runId, oldRun);
  assert.deepEqual(f.calls, ['203.0.113.44', '203.0.113.40']);
  assert.deepEqual(f.settings(), { timezone: 'Adapted', language: 'ja-JP' });
  assert.ok(adapted.history.some(item => /自动按最新出口重新适配/.test(item.message)));
  // 旧目标的观测不能落到新目标上。
  f.session.observe({ runId: oldRun, score: 0 }); assert.equal(f.session.report().score, null);
  assert.equal(await readFile(f.session.file, 'utf8'), backup);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original); assert.equal(f.session.report().phase, 'idle');
});

test('地理标签波动不触发重适配，同国家切换 IP 自动重新适配', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  f.target({ ip: '203.0.113.44', language: 'ko-KR', locale: 'ko-KR', city: 'Seoul' });
  assert.equal((await f.session.retest()).phase, 'active');
  f.target({ ip: '203.0.113.41', language: 'ko-KR', locale: 'ko-KR', city: 'Seoul' });
  assert.equal((await f.session.retest()).phase, 'active');
  assert.deepEqual(f.calls, ['203.0.113.44', '203.0.113.41']);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original);
});

test('自动重适配失败退回人工重启，且无法识别新出口时恢复原配置', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000'); await f.session.retest();
  f.target({ ip: '203.0.113.40', language: 'ja-JP', locale: 'ja-JP' });
  f.failApply(true);
  const stale = await f.session.retest();
  assert.equal(stale.phase, 'restart_required'); assert.equal(stale.enabled, true);
  assert.match(stale.testError, /自动重新适配失败/);
  assert.equal(stale.nextTestAt, null); assert.equal(stale.target.ip, '203.0.113.44');
  f.failApply(false); f.target(null);
  await assert.rejects(f.session.start('http://localhost:3000'), /无法识别/);
  assert.deepEqual(f.settings(), f.original); assert.equal(f.session.report().enabled, false);
});

test('出口反复抖动时自动重适配有节流，超限后要求人工重启', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  for (let i = 0; i < 5; i++) {
    f.target({ ip: `1.2.3.${10 + i}`, language: 'ko-KR', locale: 'ko-KR' });
    assert.equal((await f.session.retest()).phase, 'active');
  }
  f.target({ ip: '203.0.113.40', language: 'ko-KR', locale: 'ko-KR' });
  const limited = await f.session.retest();
  assert.equal(limited.phase, 'restart_required');
  assert.match(limited.testError, /反复变化/);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original);
});
test('验证得分下降40%才提醒；首次、空采样不误报，持续低分不重复提醒', async t => {
  const { session } = await fixture(t); await session.start('http://localhost:3000');
  await session.retest();
  const observe = (value, runId = '1') => session.observe({ runId, score: 100 - value / 2, verificationScore: value, verificationMaximum: 200 });
  observe(200); assert.equal(session.report().alarm, false);
  observe(121); assert.equal(session.report().alarm, false, '下降39.5%不提醒');
  observe(200); observe(120);
  assert.equal(session.report().alarm, true);
  assert.equal(session.report().scoreDropPercent, 40);
  const events = session.report().history.length;
  observe(110); assert.equal(session.report().history.length, events);
  await session.performTest(); observe(100, '2');
  assert.equal(session.report().history.length, events + 1);
  observe(200, '1'); assert.equal(session.report().score, 50);
  session.observe({ runId: '2', score: null }); assert.equal(session.report().alarm, true);
  observe(130, '2'); assert.equal(session.report().alarm, false);
  assert.throws(() => session.observe({ runId: '2', score: 50, verificationScore: 201, verificationMaximum: 200 }), /无效验证得分/);
});

test('后台重连配置完成即返回，模拟检测不会持续占用配置队列', async t => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  t.after(() => release({ state: 'passed', runId: 'late' }));
  const f = await fixture(t, { test: async () => slow });
  await f.session.start('http://localhost:3000');
  const resumed = await f.session.resume('http://localhost:3000', { background: true });
  assert.equal(resumed.testing, true);
  assert.equal(resumed.phase, 'active');
  await f.session.monitor(false);
  assert.equal(f.session.report().monitoring, false);
  await f.session.stop();
  assert.equal(f.session.report().phase, 'idle');
});

test('完整采样标识幂等，同一采样重传或中间结果不得推进比较基准', async t => {
  const { session } = await fixture(t);
  await session.start('http://localhost:3000'); await session.retest();
  const sample = (sampleId, value) => session.observe({ runId: '1', sampleId, score: 100 - value, verificationScore: value, verificationMaximum: 100 });
  sample('sample-a', 100);
  sample('sample-a', 50); assert.equal(session.report().verificationScore, 100);
  sample('sample-b', 60); assert.equal(session.report().alarm, true);
  sample('sample-b', 100); assert.equal(session.report().alarm, true);
  sample('sample-c', 80); assert.equal(session.report().alarm, false);
});
test('恢复失败保留原始快照，重试成功后清除备份', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000'); f.failRestore(true);
  assert.equal((await f.session.stop()).phase, 'restore_failed');
  const saved = JSON.parse(await readFile(f.session.file, 'utf8')); assert.deepEqual(saved.baseline, f.original);
  await assert.rejects(f.session.start('http://localhost:3000'), /未恢复/);
  f.failRestore(false); await f.session.stop(); assert.deepEqual(f.settings(), f.original);
  await assert.rejects(readFile(f.session.file), { code: 'ENOENT' });
});
test('进程重启后先恢复未完成的配置，避免丢失原始状态', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  clearInterval(f.session.timer);
  const restarted = new ProtectionSession(f.options); await restarted.recover();
  assert.equal(restarted.report().phase, 'idle'); assert.deepEqual(f.settings(), f.original);
  assert.equal(restarted.report().desiredEnabled, true);
});

test('唤醒后重新适配变化的出口并检测，始终保留首次恢复备份', async t => {
  const f = await fixture(t);
  await f.session.start('http://localhost:3000'); await f.session.retest();
  const backup = await readFile(f.session.file, 'utf8');
  f.target({ ip: '203.0.113.40', language: 'ja-JP', locale: 'ja-JP' });
  f.failApply(true);
  assert.equal((await f.session.retest()).phase, 'restart_required');
  f.failApply(false);
  const report = await f.session.resume('http://localhost:3000');
  assert.equal(report.phase, 'active'); assert.equal(report.testState, 'passed');
  assert.equal(report.target.ip, '203.0.113.40'); assert.equal(report.score, null);
  assert.deepEqual(f.calls, ['203.0.113.44', '203.0.113.40', '203.0.113.40']);
  assert.equal(await readFile(f.session.file, 'utf8'), backup);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original);
});

test('唤醒网络未就绪时保留保护意愿，下次重连成功清除错误', async t => {
  let offline = false;
  const f = await fixture(t, { detect: async () => {
    if (offline) throw new Error('network offline');
    return { ip: '203.0.113.44', language: 'ko-KR', locale: 'ko-KR' };
  } });
  await f.session.start('http://localhost:3000');
  offline = true;
  const failed = await f.session.resume('http://localhost:3000');
  assert.equal(failed.enabled, true); assert.equal(failed.desiredEnabled, true);
  assert.equal(failed.testState, 'failed'); assert.equal(failed.score, null);
  assert.match(failed.testError, /network offline/);
  offline = false;
  const recovered = await f.session.resume('http://localhost:3000');
  assert.equal(recovered.testState, 'passed'); assert.equal(recovered.testError, null);
});

test('退出后重新打开自动保护，手动关闭后唤醒和重启均不自动开启', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  await f.session.stop({ shutdown: true });
  const reopened = new ProtectionSession(f.options);
  t.after(() => clearInterval(reopened.timer));
  await reopened.recover();
  assert.equal(reopened.report().enabled, false); assert.equal(reopened.report().desiredEnabled, true);
  const active = await reopened.resume('http://localhost:3001');
  assert.equal(active.enabled, true); assert.equal(active.testState, 'passed');
  await reopened.stop();
  const calls = f.calls.length;
  await reopened.resume('http://localhost:3001');
  const restarted = new ProtectionSession(f.options); await restarted.recover();
  await restarted.resume('http://localhost:3001');
  assert.equal(restarted.report().desiredEnabled, false); assert.equal(restarted.report().enabled, false);
  assert.equal(f.calls.length, calls);
});

test('手动关闭会取消排队的唤醒重连，恢复失败时不擅自开启', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  const calls = f.calls.length;
  const resumed = f.session.resume('http://localhost:3000');
  const stopped = f.session.stop();
  await resumed; await stopped;
  assert.equal(f.calls.length, calls); assert.equal(f.session.report().enabled, false);
  await f.session.start('http://localhost:3000'); f.failRestore(true);
  await f.session.stop({ shutdown: true });
  assert.equal(f.session.report().phase, 'restore_failed');
  await f.session.resume('http://localhost:3000');
  assert.equal(f.session.report().phase, 'restore_failed');
});

test('启动期间排队的唤醒不能越过后续关闭，重新打开网络未就绪仍可重试', async t => {
  let release, offline = false;
  const applying = new Promise(resolve => { release = resolve; });
  let applies = 0;
  const f = await fixture(t, {
    detect: async () => {
      if (offline) throw new Error('network not ready');
      return { ip: '203.0.113.44', language: 'ko-KR', locale: 'ko-KR' };
    },
    apply: async () => { applies++; await applying; return []; },
  });
  const starting = f.session.start('http://localhost:3000');
  const wake = f.session.resume('http://localhost:3000');
  const stopping = f.session.stop(); release();
  await Promise.all([starting, wake, stopping]);
  assert.equal(applies, 1); assert.equal(f.session.report().desiredEnabled, false);
  await f.session.start('http://localhost:3000'); await f.session.stop({ shutdown: true });
  const reopened = new ProtectionSession(f.options);
  t.after(() => clearInterval(reopened.timer));
  await reopened.recover(); offline = true;
  await assert.rejects(reopened.resume('http://localhost:3001'), /network not ready/);
  assert.equal(reopened.report().desiredEnabled, true); assert.equal(reopened.report().enabled, false);
  offline = false; await reopened.resume('http://localhost:3001');
  assert.equal(reopened.report().testState, 'passed'); await reopened.stop();
});
test('关闭等待进行中的启动结束，再恢复；重复关闭幂等', async t => {
  const f = await fixture(t, { apply: async () => { await delay(30); return []; } });
  const starting = f.session.start('http://localhost:3000'); const stopping = f.session.stop();
  await starting; await stopping; await f.session.stop();
  assert.equal(f.session.report().enabled, false); assert.deepEqual(f.settings(), f.original);
});
test('周期任务真实发起测试，不并发；关闭监测后停止调度', async t => {
  let concurrent = 0, peak = 0, count = 0;
  const f = await fixture(t, { intervalMs: 15, test: async () => { peak = Math.max(peak, ++concurrent); await delay(25); concurrent--; return { runId: String(++count), state: 'passed' }; } });
  await f.session.start('http://localhost:3000'); await delay(85); await f.session.monitor(false, 60000);
  while (f.session.report().testing) await delay(5);
  assert.ok(count >= 2); assert.equal(peak, 1); assert.equal(f.session.report().nextTestAt, null);
  const stoppedAt = count; await delay(45); assert.equal(count, stoppedAt);
});
test('检测间隔更新实际调度，非法间隔不改变状态', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  let report = await f.session.monitor(true, 300000);
  assert.equal(report.intervalMs, 300000);
  assert.ok(Math.abs(Date.parse(report.nextTestAt) - Date.now() - 300000) < 1000);
  for (const value of [0, -1, 29999, 600001, '60000', NaN, Infinity]) assert.throws(() => f.session.monitor(true, value), /检测间隔/);
  assert.equal(f.session.report().intervalMs, 300000);
  report = await f.session.monitor(false, 30000);
  assert.equal(report.nextTestAt, null); assert.equal(report.intervalMs, 30000);
  report = await f.session.monitor(true);
  assert.ok(Math.abs(Date.parse(report.nextTestAt) - Date.now() - 30000) < 1000);
});

test('实时检测开关和间隔立即落盘，停止、退出和启动意愿修改不会覆盖；重启恢复调度', async t => {
  const f = await fixture(t);
  await f.session.monitor(false, 300000);
  let saved = JSON.parse(await readFile(f.session.preferenceFile, 'utf8'));
  assert.deepEqual(saved, { enabled: false, monitoring: false, intervalMs: 300000 });
  await f.session.startupPreference(true);
  await f.session.resume('http://localhost:3000');
  assert.equal(f.session.report().nextTestAt, null);
  await f.session.stop({ shutdown: true });
  const reopened = new ProtectionSession(f.options);
  t.after(() => reopened.stop());
  let report = await reopened.recover();
  assert.equal(report.desiredEnabled, true);
  assert.equal(report.monitoring, false);
  assert.equal(report.intervalMs, 300000);
  await reopened.resume('http://localhost:3000');
  assert.equal(reopened.report().nextTestAt, null);
  await reopened.monitor(true, 600000);
  await reopened.stop();
  saved = JSON.parse(await readFile(f.session.preferenceFile, 'utf8'));
  assert.deepEqual(saved, { enabled: false, monitoring: true, intervalMs: 600000 });
  const again = new ProtectionSession(f.options);
  t.after(() => again.stop());
  await again.recover();
  report = await again.start('http://localhost:3000');
  assert.equal(report.intervalMs, 600000);
  assert.ok(Math.abs(Date.parse(report.nextTestAt) - Date.now() - 600000) < 1000);
});

test('旧配置兼容默认实时检测；无效监测字段回退，不影响开启保护意愿', async t => {
  for (const extra of [{}, { monitoring: 'false', intervalMs: 0 }, { monitoring: true, intervalMs: 600001 }]) {
    const f = await fixture(t);
    await writeFile(f.session.preferenceFile, JSON.stringify({ enabled: true, ...extra }));
    const report = await f.session.recover();
    assert.equal(report.desiredEnabled, true);
    assert.equal(report.monitoring, true);
    assert.equal(report.intervalMs, 60000);
  }
});

test('连续修改按顺序保存，写入失败不改变已生效的开关、间隔或定时器', async t => {
  const f = await fixture(t);
  await f.session.start('http://localhost:3000');
  await Promise.all([f.session.monitor(false, 300000), f.session.monitor(true, 30000), f.session.monitor(false)]);
  assert.deepEqual(JSON.parse(await readFile(f.session.preferenceFile, 'utf8')), { enabled: true, monitoring: false, intervalMs: 30000 });
  await f.session.monitor(true);
  const before = f.session.report();
  const timer = f.session.timer;
  const originalFile = f.session.preferenceFile;
  const blocker = path.join(f.options.stateDir, 'not-a-directory');
  await writeFile(blocker, 'block');
  f.session.preferenceFile = path.join(blocker, 'preference.json');
  try {
    await assert.rejects(f.session.monitor(false, 600000));
    assert.equal(f.session.report().monitoring, before.monitoring);
    assert.equal(f.session.report().intervalMs, before.intervalMs);
    assert.equal(f.session.report().nextTestAt, before.nextTestAt);
    assert.equal(f.session.timer, timer);
  } finally { f.session.preferenceFile = originalFile; }
});

test('手动复检真实执行且保留监测配置，未启动时拒绝保护测试', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.retest(), /先启动/);
  await f.session.start('http://localhost:3000');
  await f.session.monitor(false, 300000);
  const before = f.session.report();
  const after = await f.session.retest();
  assert.notEqual(after.runId, before.runId); assert.equal(after.testState, 'passed');
  assert.equal(after.monitoring, false); assert.equal(after.nextTestAt, null); assert.equal(after.intervalMs, 300000);
});

test('启动适配失败时自动回滚；检测失败不能提交零分冒充正常', async t => {
  const f = await fixture(t, { apply: async () => { throw new Error('apply failed'); } });
  await assert.rejects(f.session.start('http://localhost:3000'), /apply failed/); assert.equal(f.session.report().phase, 'idle');
  const g = await fixture(t, { test: async () => { throw new Error('network failed'); } });
  await g.session.start('http://localhost:3000'); await g.session.retest(); g.session.observe({ runId: g.session.report().runId, score: 0 });
  assert.equal(g.session.report().score, null); assert.equal(g.session.report().testState, 'failed');
});
test('检测失败保留真实原因，关闭成功清除旧检测错误和轮次', async t => {
  const f = await fixture(t, { test: async () => ({ runId: 'failed-run', state: 'failed', error: 'proxy connection failed' }) });
  await f.session.start('http://localhost:3000');
  const failed = await f.session.retest();
  assert.equal(failed.testError, 'proxy connection failed');
  for (let i = 0; i < 2; i++) {
    const stopped = await f.session.stop();
    assert.equal(stopped.phase, 'idle'); assert.equal(stopped.runId, null);
    assert.equal(stopped.testError, null); assert.equal(stopped.testState, 'pending');
  }
});

test('IP 情报冲突时拒绝适配，韩国出口映射到韩国时区和语言', () => {
  assert.throws(() => targetFromExit({ primary: { ip: '203.0.113.44', countryCode: 'KR' }, consistentCountry: false }), /冲突/);
  const target = targetFromExit({ primary: { ip: '203.0.113.44', countryCode: 'KR', timezone: 'Asia/Seoul', city: 'Seoul' } });
  assert.equal(target.windowsTimezone, 'Korea Standard Time'); assert.equal(target.language, 'ko-KR');
  assert.equal(target.hosting, false);
});

test('云机房出口在目标里带 hosting 标记，界面可以提示 Claude 可能拒绝', () => {
  const target = targetFromExit({ primary: { ip: '43.133.78.123', countryCode: 'KR', timezone: 'Asia/Seoul', asn: 132203, org: '6 COLLYER QUAY', isp: 'Shenzhen Tencent Computer Systems Company Limited', domain: 'tencent.com' } });
  assert.equal(target.hosting, true);
  assert.equal(target.asn, 132203);
  const residential = targetFromExit({ primary: { ip: '203.0.113.44', countryCode: 'KR', asn: 4766, org: 'Korea Telecom' } });
  assert.equal(residential.hosting, false);
});

test('启动保护自动接入浏览器，复用已有连接，启动或验证失败仍报告部分生效', async t => {
  for (const scenario of ['disconnected', 'verified', 'launch', 'apply', 'headers']) await t.test(scenario, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-protection-browser-'));
    const target = targetFromExit({ primary: { ip: '203.0.113.44', countryCode: 'KR', timezone: 'Asia/Seoul' } });
    let appliedTargets = [];
    let launches = 0;
    const runtime = {
      clients: new Map(['disconnected', 'launch'].includes(scenario) ? [] : [['web', {}]]), policy: {}, enabled: false, load: async () => {},
      async apply(policy, _origin, kinds) {
        appliedTargets = kinds; this.policy = policy; this.enabled = true;
        const results = kinds.map(kind => {
          if (!this.clients.has(kind)) {
            launches++;
            if (scenario === 'launch') return { target: kind, state: 'failed', detail: 'browser launch failed', pages: 0 };
            this.clients.set(kind, {});
          }
          if (scenario === 'apply') return { target: kind, state: 'failed', detail: 'browser configuration failed', pages: 0 };
          return { target: kind, state: 'verified', detail: 'sample verified', pages: 1 };
        });
        return { policy, results, appliedAt: 'now' };
      },
      async probeBrowserHeaders() {
        return this.clients.has('web') && scenario !== 'headers'
          ? { state: 'verified', receivedLanguage: 'ko-KR,ko,en' }
          : { state: 'unverified', detail: 'browser headers not verified' };
      },
      async restore() { this.enabled = false; return { results: [] }; },
    };
    const browserCloak = new BrowserCloakController(runtime, { intervalMs: 1000000 });
    browserCloak.gatewayState = async () => ({ cloak: { enabled: true, updatedAt: 'one' }, profile: { language: target.language, locale: target.locale } });
    const session = createProtectionService({ stateDir, runtime, browserCloak, platform: 'win32',
      currentZone: async () => target.windowsTimezone,
      setZone: async () => assert.fail('时区相同时不应修改系统'),
      gatewayRequest: async () => ({ cloak: { enabled: false } }),
    });
    session.detect = async () => target;
    t.after(async () => {
      try { await session.stop(); } finally { await browserCloak.close(); await rm(stateDir, { recursive: true, force: true }); }
    });
    const report = await session.start('http://localhost:3000');
    assert.deepEqual(appliedTargets, ['web']);
    assert.equal(launches, ['disconnected', 'launch'].includes(scenario) ? 1 : 0);
    assert.equal(report.enabled, true);
    if (['launch', 'apply', 'headers'].includes(scenario)) {
      assert.equal(report.phase, 'partial');
      assert.ok(report.issues.includes(scenario === 'launch' ? 'browser launch failed' : scenario === 'apply' ? 'browser configuration failed' : 'browser headers not verified'));
      if (scenario === 'launch') assert.equal(runtime.clients.size, 0);
      session.refreshBrowser({ results: [{ target: 'web', state: 'verified', detail: 'sample verified' }], requestProbe: { state: 'verified' } });
      assert.deepEqual(session.report().issues, []);
      assert.equal(session.report().phase, 'active');
    } else {
      assert.equal(browserCloak.report.requestProbe.state, 'verified');
      assert.equal(browserCloak.report.results[0].state, 'verified');
      assert.deepEqual(report.issues, []);
      assert.equal(report.phase, 'active');
      await browserCloak.sync('http://localhost:3000', { launch: true, force: true });
      assert.equal(launches, scenario === 'disconnected' ? 1 : 0, '同步应复用浏览器连接');
    }
  });
});


test('macOS 开启保护适配 IANA 时区，复检不覆盖手动设置，关闭时恢复基线', async t => {
  for (const denied of [false, true]) await t.test(denied ? '取消系统授权' : '应用与恢复', async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-mac-timezone-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    let zone = 'Asia/Shanghai';
    const calls = [];
    const runtime = { policy: {}, enabled: false, clients: new Map(), load: async () => {}, restore: async () => ({ results: [] }) };
    const browserCloak = { sync: async () => ({ results: [], requestProbe: { state: 'verified' } }), close: async () => {} };
    const session = createProtectionService({ stateDir, runtime, browserCloak, platform: 'darwin',
      currentZone: async () => zone,
      setZone: async target => { calls.push(target); if (denied) throw new Error('已取消系统授权'); zone = target; },
      gatewayRequest: async () => ({ cloak: { enabled: false } }),
    });
    session.detect = async () => targetFromExit({ primary: { ip: '203.0.113.44', countryCode: 'KR', timezone: 'Asia/Seoul' } });
    session.test = async () => ({ state: 'passed' });
    const started = await session.start('http://localhost:3000');
    assert.deepEqual(calls, ['Asia/Seoul']);
    if (denied) {
      assert.equal(zone, 'Asia/Shanghai');
      assert.equal(started.phase, 'partial');
      assert.match(started.issues.join(), /系统时区适配失败.*取消/);
    } else {
      assert.equal(zone, 'Asia/Seoul');
      zone = 'Asia/Tokyo';
      await session.retest();
      assert.equal(zone, 'Asia/Tokyo');
      assert.equal(calls.length, 1, '周期复检不得写入或恢复系统时区');
    }
    const stopped = await session.stop();
    assert.equal(stopped.phase, 'idle');
    assert.equal(zone, 'Asia/Shanghai');
  });
});


test('启动保护开关独立控制下一次启动，不依赖上次手动开关结果且不覆盖活跃会话', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-startup-preference-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const session = new ProtectionSession({ stateDir, snapshot: async () => ({}), apply: async () => [], restore: async () => [], detect: async () => ({ ip: '203.0.113.44', language: 'en', locale: 'en-US' }), test: async () => ({ state: 'passed' }) });
  assert.equal((await session.startupPreference(true)).desiredEnabled, true);
  assert.equal(session.report().enabled, false, '启动配置只设定意愿，由正常恢复流程开启保护');
  assert.equal((await session.startupPreference(false)).desiredEnabled, false);
  await session.start('http://localhost:3000');
  await assert.rejects(session.startupPreference(false), /尚未恢复/);
  await session.stop();
});

test('固定出口在 Claude 不支持地区时拒绝启动，且不写入任何浏览器/网关配置', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-protection-region-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let applied = 0;
  const kernel = {
    report: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    verifyConnection: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    setTunnel: async () => ({ changed: false }),
    connectionState: () => ({ strictEnabled: false }),
    probeSelectedExit: async () => ({ ip: '203.0.113.9', countryCode: 'CN', timezone: 'Asia/Shanghai' }),
  };
  const service = createProtectionService({
    stateDir,
    runtime: { load: async () => ({}) },
    browserCloak: { sync: async () => ({ results: [], requestProbe: null }), close: async () => {} },
    currentZone: async () => 'Asia/Shanghai',
    setZone: async () => {},
    restoreTimezone: async () => {},
    canTest: () => true,
    network: () => kernel,
    platform: 'darwin',
    gatewayRequest: async () => { applied += 1; return { cloak: { enabled: false } }; },
  });
  await assert.rejects(service.start('http://localhost:3000'), /固定出口位于 Claude 不支持的地区：CN/);
  assert.equal(applied, 0, '地区校验失败后不得碰浏览器/网关配置');
  assert.equal(service.report().enabled, false);
  assert.match(service.report().issues.join(), /Claude 不支持的地区：CN/);
});

test('关闭保护时建立未保护阻断，开启保护先解除阻断', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-unprotected-block-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const kernel = {
    report: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    verifyConnection: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    setTunnel: async value => { calls.push(`tunnel:${value}`); },
    setUnprotectedGuard: async value => { calls.push(`guard:${value}`); },
    connectionState: () => ({ strictEnabled: false }),
    probeSelectedExit: async () => ({ ip: '203.0.113.9', countryCode: 'KR', timezone: 'Asia/Seoul' }),
  };
  const service = createProtectionService({
    stateDir,
    runtime: { policy: {}, enabled: false, clients: new Map(), load: async () => {}, restore: async () => ({ results: [] }), close: async () => ({ results: [] }) },
    browserCloak: { sync: async () => ({ results: [], requestProbe: { state: 'verified' } }), close: async () => {} },
    currentZone: async () => 'Asia/Seoul',
    setZone: async () => {},
    restoreTimezone: async () => {},
    canTest: () => true,
    network: () => kernel,
    platform: 'linux',
    gatewayRequest: async () => ({ cloak: { enabled: false } }),
  });
  service.detect = async () => ({ ip: '203.0.113.9', language: 'ko', locale: 'ko-KR' });
  await service.start('http://localhost:3000');
  assert.deepEqual(calls.slice(0, 2), ['guard:false', 'tunnel:true']);

  calls.length = 0;
  const stopped = await service.stop();
  assert.equal(stopped.phase, 'idle');
  assert.equal(stopped.unprotectedBlock.active, true);
  assert.deepEqual(calls, ['guard:true'], '关闭保护后保持接管并阻断 Claude');

  calls.length = 0;
  await service.start('http://localhost:3000');
  assert.deepEqual(calls.slice(0, 2), ['guard:false', 'tunnel:true'], '开启保护必须先解除阻断');
  assert.equal(service.report().unprotectedBlock.active, false);
  await service.stop();
});

test('未保护阻断建立失败时如实报告原因，不阻止关闭保护', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-unprotected-block-fail-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const kernel = {
    report: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    verifyConnection: async () => ({ state: 'running', tunEnabled: true, tunCaptured: true }),
    setTunnel: async () => {},
    setUnprotectedGuard: async value => { if (value) throw new Error('TUN 需要更高权限'); },
    connectionState: () => ({ strictEnabled: false }),
    probeSelectedExit: async () => ({ ip: '203.0.113.9', countryCode: 'KR', timezone: 'Asia/Seoul' }),
  };
  const service = createProtectionService({
    stateDir,
    runtime: { policy: {}, enabled: false, clients: new Map(), load: async () => {}, restore: async () => ({ results: [] }), close: async () => ({ results: [] }) },
    browserCloak: { sync: async () => ({ results: [], requestProbe: { state: 'verified' } }), close: async () => {} },
    currentZone: async () => 'Asia/Seoul',
    setZone: async () => {},
    restoreTimezone: async () => {},
    canTest: () => true,
    network: () => kernel,
    platform: 'linux',
    gatewayRequest: async () => ({ cloak: { enabled: false } }),
  });
  service.detect = async () => ({ ip: '203.0.113.9', language: 'ko', locale: 'ko-KR' });
  await service.start('http://localhost:3000');
  const stopped = await service.stop();
  assert.equal(stopped.phase, 'idle');
  assert.equal(stopped.unprotectedBlock.active, false);
  assert.match(stopped.unprotectedBlock.error, /更高权限/);
});
