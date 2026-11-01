import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtectionSession } from './protection-session.mjs';
import { createProtectionService, targetFromExit } from './protection-service.mjs';
import { BrowserCloakController } from './browser-cloak.mjs';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-protection-'));
  let settings = { timezone: 'Original', language: 'original' };
  let target = { ip: '1.2.3.4', language: 'ko-KR', locale: 'ko-KR' };
  let sequence = 0, failure = false;
  const calls = [];
  const options = { stateDir, intervalMs: 60000, snapshot: async () => structuredClone(settings), detect: async () => target,
    apply: async next => { calls.push(next.ip); settings = { timezone: 'Adapted', language: next.language }; return []; },
    restore: async baseline => { if (failure) return ['temporary restore failure']; settings = structuredClone(baseline); return []; },
    test: async () => ({ runId: String(++sequence), state: 'passed' }), ...overrides };
  const session = new ProtectionSession(options);
  t.after(async () => { failure = false; await session.stop(); await rm(stateDir, { recursive: true, force: true }); });
  return { session, options, calls, original: structuredClone(settings), settings: () => settings, target: value => target = value, failRestore: value => failure = value };
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

test('节点变化仅提示重启，点击后重新识别最新出口且保留首次恢复备份', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000'); await f.session.retest();
  const backup = await readFile(f.session.file, 'utf8');
  const oldRun = f.session.report().runId;
  f.session.observe({ runId: oldRun, score: 70 });
  f.target({ ip: '5.6.7.8', language: 'ja-JP', locale: 'ja-JP' });
  await f.session.retest();
  const stale = f.session.report();
  assert.equal(stale.phase, 'restart_required'); assert.equal(stale.target.ip, '1.2.3.4');
  assert.equal(stale.runId, null); assert.equal(stale.score, null); assert.equal(stale.alarm, false);
  assert.equal(stale.nextTestAt, null); assert.equal(stale.testState, 'stale');
  assert.match(stale.testError, /重新启动保护/);
  assert.deepEqual(f.calls, ['1.2.3.4']);
  f.session.observe({ runId: oldRun, score: 0 }); assert.equal(f.session.report().score, null);
  await f.session.retest(); assert.deepEqual(f.calls, ['1.2.3.4']);
  // The node changes again while the prompt is visible: never reuse that observation.
  f.target({ ip: '9.10.11.12', language: 'en-US', locale: 'en-US' });
  await f.session.start('http://localhost:3000');
  const active = await f.session.retest();
  assert.deepEqual(f.calls, ['1.2.3.4', '9.10.11.12']);
  assert.equal(active.phase, 'active'); assert.equal(active.testError, null);
  assert.equal(active.target.ip, '9.10.11.12'); assert.equal(active.testState, 'passed');
  assert.equal(await readFile(f.session.file, 'utf8'), backup);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original); assert.equal(f.session.report().phase, 'idle');
});

test('地理标签波动不触发重启，同国家切换 IP 仍需用户重新启动', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  f.target({ ip: '1.2.3.4', language: 'ko-KR', locale: 'ko-KR', city: 'Seoul' });
  assert.equal((await f.session.retest()).phase, 'active');
  f.target({ ip: '1.2.3.5', language: 'ko-KR', locale: 'ko-KR', city: 'Seoul' });
  assert.equal((await f.session.retest()).phase, 'restart_required');
  assert.deepEqual(f.calls, ['1.2.3.4']);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original);
});

test('重新启动无法识别新出口时恢复原配置，不沿用旧目标', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  f.target({ ip: '5.6.7.8', language: 'ja-JP', locale: 'ja-JP' });
  await f.session.retest(); f.target(null);
  await assert.rejects(f.session.start('http://localhost:3000'), /无法识别/);
  assert.deepEqual(f.calls, ['1.2.3.4']); assert.deepEqual(f.settings(), f.original);
  assert.equal(f.session.report().enabled, false);
});
test('49 和 50 不报警，51 报警；持续异常不重复报警，旧采样不能覆盖当前结果', async t => {
  const { session } = await fixture(t); await session.start('http://localhost:3000');
  await session.retest();
  for (const score of [49, 50, 51]) { session.observe({ runId: '1', score }); assert.equal(session.report().alarm, score > 50); }
  const events = session.report().history.length;
  await session.performTest(); session.observe({ runId: '2', score: 51 });
  assert.equal(session.report().history.length, events + 1);
  session.observe({ runId: '1', score: 0 }); assert.equal(session.report().score, 51);
  session.observe({ runId: '2', score: 50 }); assert.equal(session.report().alarm, false);
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
  f.target({ ip: '5.6.7.8', language: 'ja-JP', locale: 'ja-JP' });
  await f.session.retest();
  assert.equal(f.session.report().phase, 'restart_required');
  const report = await f.session.resume('http://localhost:3000');
  assert.equal(report.phase, 'active'); assert.equal(report.testState, 'passed');
  assert.equal(report.target.ip, '5.6.7.8'); assert.equal(report.score, null);
  assert.deepEqual(f.calls, ['1.2.3.4', '5.6.7.8']);
  assert.equal(await readFile(f.session.file, 'utf8'), backup);
  await f.session.stop(); assert.deepEqual(f.settings(), f.original);
});

test('唤醒网络未就绪时保留保护意愿，下次重连成功清除错误', async t => {
  let offline = false;
  const f = await fixture(t, { detect: async () => {
    if (offline) throw new Error('network offline');
    return { ip: '1.2.3.4', language: 'ko-KR', locale: 'ko-KR' };
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
      return { ip: '1.2.3.4', language: 'ko-KR', locale: 'ko-KR' };
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
  await f.session.start('http://localhost:3000'); await delay(85); f.session.monitor(false, 60000); await f.session.queue;
  assert.ok(count >= 2); assert.equal(peak, 1); assert.equal(f.session.report().nextTestAt, null);
  const stoppedAt = count; await delay(45); assert.equal(count, stoppedAt);
});
test('检测间隔更新实际调度，非法间隔不改变状态', async t => {
  const f = await fixture(t); await f.session.start('http://localhost:3000');
  let report = f.session.monitor(true, 300000);
  assert.equal(report.intervalMs, 300000);
  assert.ok(Math.abs(Date.parse(report.nextTestAt) - Date.now() - 300000) < 1000);
  for (const value of [0, -1, 29999, 600001, '60000', NaN, Infinity]) assert.throws(() => f.session.monitor(true, value), /检测间隔/);
  assert.equal(f.session.report().intervalMs, 300000);
  report = f.session.monitor(false, 30000);
  assert.equal(report.nextTestAt, null); assert.equal(report.intervalMs, 30000);
  report = f.session.monitor(true);
  assert.ok(Math.abs(Date.parse(report.nextTestAt) - Date.now() - 30000) < 1000);
});

test('手动复检真实执行且保留监测配置，未启动时拒绝保护测试', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.retest(), /先启动/);
  await f.session.start('http://localhost:3000');
  f.session.monitor(false, 300000);
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
  assert.throws(() => targetFromExit({ primary: { ip: '1.2.3.4', countryCode: 'KR' }, consistentCountry: false }), /冲突/);
  const target = targetFromExit({ primary: { ip: '1.2.3.4', countryCode: 'KR', timezone: 'Asia/Seoul', city: 'Seoul' } });
  assert.equal(target.windowsTimezone, 'Korea Standard Time'); assert.equal(target.language, 'ko-KR');
});

test('启动保护不打开浏览器，已有连接继续验证，未连接或验证失败仍报告部分生效', async t => {
  for (const scenario of ['disconnected', 'verified', 'apply', 'headers']) await t.test(scenario, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'checkcc-protection-browser-'));
    const target = targetFromExit({ primary: { ip: '1.2.3.4', countryCode: 'KR', timezone: 'Asia/Seoul' } });
    let appliedTargets = [];
    const runtime = {
      clients: new Map(scenario === 'disconnected' ? [] : [['web', {}]]), policy: {}, enabled: false, load: async () => {},
      async apply(policy, _origin, kinds) {
        appliedTargets = kinds; this.policy = policy; this.enabled = true;
        const results = kinds.map(kind => {
          assert.ok(this.clients.has(kind), '启动保护不得创建新浏览器连接');
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
    const session = createProtectionService({ stateDir, runtime, browserCloak,
      currentZone: async () => target.windowsTimezone,
      setZone: async () => assert.fail('时区相同时不应修改系统'),
      gatewayRequest: async () => ({ cloak: { enabled: false } }),
    });
    session.detect = async () => target;
    t.after(async () => {
      try { await session.stop(); } finally { await browserCloak.close(); await rm(stateDir, { recursive: true, force: true }); }
    });
    const report = await session.start('http://localhost:3000');
    assert.deepEqual(appliedTargets, scenario === 'disconnected' ? [] : ['web']);
    assert.equal(report.enabled, true);
    if (scenario !== 'verified') {
      assert.equal(report.phase, 'partial');
      assert.ok(report.issues.includes(scenario === 'apply' ? 'browser configuration failed' : 'browser headers not verified'));
      if (scenario === 'disconnected') assert.equal(runtime.clients.size, 0);
      session.refreshBrowser({ results: [{ target: 'web', state: 'verified', detail: 'sample verified' }], requestProbe: { state: 'verified' } });
      assert.deepEqual(session.report().issues, []);
      assert.equal(session.report().phase, 'active');
    } else {
      assert.equal(browserCloak.report.requestProbe.state, 'verified');
      assert.equal(browserCloak.report.results[0].state, 'verified');
      assert.deepEqual(report.issues, []);
      assert.equal(report.phase, 'active');
    }
  });
});
