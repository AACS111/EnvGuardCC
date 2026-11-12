// 连接控制回归：不启用系统 TUN，不修改时区、系统代理或防火墙。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yaml, stringify } from "yaml";
import { netCoreView, trafficFlowSamples } from "../src/detection/net-core-view.mjs";
import { routingEvidence } from "./net-core/routes.mjs";
import { createKernelRuntime, loadNodes } from "./net-core/runtime.mjs";
import { migrateStore } from "./net-core/sources.mjs";
import { recordExit, readExitHistory } from "./net-core/exit-history.mjs";
import { readHostConfig } from "./net-core/host.mjs";
import { HOST_PROTOCOL, HOST_CAPABILITIES } from './net-core/host-protocol.mjs';
import { buildHostInstallPlan } from "./net-core/service.mjs";
import { stageHostBundle } from "./net-core/host-bundle.mjs";
import { createNetCore } from "./net-core.mjs";
import { pickPortBlock } from './net-core/ports.mjs';
import { ProtectionSession } from "./protection-session.mjs";
import { createClaudeProxySettings } from './claude-proxy-settings.mjs';

const node = name => ({ name, type: "ss", server: "203.0.113.10", port: 443, cipher: "aes-128-gcm", password: "test" });

test("路径采样包含国内普通代理、直连和阻断，且不冒充 Claude 专用出口证据", () => {
  const connection = (host, chains) => ({ metadata: { host }, chains });
  const routing = routingEvidence({ connections: [
    connection("www.baidu.com", ["node-a", "AUTO-PROXY"]),
    connection("www.example.com", ["node-a", "AUTO-PROXY"]),
    connection("intranet.example", ["ENVGUARD-LOCAL-DIRECT"]),
    connection("192.168.1.1", ["DIRECT"]),
    connection("dns.example", ["ENVGUARD-LOCAL-DNS"]),
    connection("blocked.example", ["REJECT"]),
    connection("dropped.example", ["REJECT-DROP"]),
    connection("pending.example", []),
    connection("unknown.example", ["PASS"]),
    connection("claude.ai", ["node-a", "CLAUDE-PIN"]),
  ] });
  assert.deepEqual(routing.traffic, { proxied: 2, direct: 3, blocked: 2, unknown: 2 });
  assert.deepEqual(routing.paths, { proxied: 3, direct: 3, blocked: 2, unknown: 2 });
  assert.equal(routing.pinned, 1);
  assert.equal(routing.direct, 0, "普通直连不是 Claude 直连违规");
  const report = { state: "running", routing };
  assert.deepEqual(trafficFlowSamples(report), { ...routing.paths, pinned: 1 });
  for (const extra of [{ demo: true }, { state: "idle" }, { state: "unavailable" }, { routing: { ...routing, sampledAt: new Date(Date.now() - 60000).toISOString() } }]) {
    assert.ok(Object.values(trafficFlowSamples({ ...report, ...extra })).every(count => count === null));
  }
  assert.equal(trafficFlowSamples({ ...report, routing: { ...routing, traffic: undefined, paths: undefined } }).proxied, null);
  const ordinaryOnly = routingEvidence([connection("www.baidu.com", ["node-a", "AUTO-PROXY"])]);
  assert.equal(ordinaryOnly.state, "unknown", "国内普通代理流量不能证明 Claude 已验证");
  assert.equal(trafficFlowSamples({ state: "running", routing: ordinaryOnly }).proxied, 1);
});

test("隧道探测使用不同的新域名和 IPv4，等待 DNS 接管但不接受真实公网地址", async () => {
  const queries = [];
  const core = createNetCore({ binary: '/kernel', homeDir: '/tmp', configPath: '/tmp/test.yaml',
    lookup: async (host, options) => { queries.push(host); assert.equal(options.family, 4); return { address: queries.length === 1 ? '203.0.113.1' : '198.18.0.10' }; },
  });
  assert.equal((await core.tunnelStatus()).active, false);
  assert.equal((await core.tunnelStatus()).active, true);
  assert.notEqual(queries[0], queries[1]);
  assert.match(queries[0], /^egcc-[a-f0-9-]+\.claude\.ai$/);
  queries.length = 0;
  assert.equal((await core.tunnelStatus({ waitMs: 1000 })).active, true);
  assert.equal(queries.length, 2);
});
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "egcc-safety-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("只有新鲜路由与明确隧道接管证据才能显示成功", () => {
  const current = { state: "running", tunEnabled: true, tunCaptured: true, routing: { state: "verified", claude: 1, pinned: 1, direct: 0, sampledAt: new Date().toISOString() } };
  assert.equal(netCoreView(current).tone, "ok");
  for (const captured of [null, false, undefined]) {
    assert.notEqual(netCoreView({ ...current, tunCaptured: captured }).tone, "ok");
  }
  for (const sampledAt of [undefined, "bad", new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 60000).toISOString()]) {
    assert.notEqual(netCoreView({ ...current, routing: { ...current.routing, sampledAt } }).tone, "ok");
  }
  for (const extra of [{ demo: true }, { tunEnabled: false }, { state: "unavailable" }, { state: "error" }, { strictMode: true, capabilities: { strictTravel: false } }]) {
    assert.notEqual(netCoreView({ ...current, ...extra }).tone, "ok");
  }
});

test("区域锁定必须显示为阻断，不能继续显示通过", () => {
  const current = { state: "running", tunEnabled: true, tunCaptured: true, routing: { state: "verified", claude: 1, pinned: 1, direct: 0, sampledAt: new Date().toISOString() } };
  const locked = netCoreView({ ...current, regionLock: { locked: true, type: "region", reason: "固定出口 CN 不在 Claude 支持地区" } });
  assert.equal(locked.tone, "danger");
  assert.match(locked.conclusion.title, /阻断/);
  assert.match(locked.conclusion.detail, /CN/);
  assert.match(locked.conclusion.detail, /复检并解除/, "地区锁必须提示人工确认");
  // 网络波动的锁会自动复检：界面必须说清楚不用手动点，并显示复检进度。
  const networkLock = netCoreView({ ...current, regionLock: { locked: true, type: "network", autoRecover: true, recheckAttempts: 3, reason: "网络中断或波动" } });
  assert.equal(networkLock.tone, "danger");
  assert.match(networkLock.conclusion.detail, /自动复检/);
  assert.match(networkLock.conclusion.detail, /第 3 次/);
  assert.doesNotMatch(networkLock.conclusion.detail, /切换节点后/);
  assert.equal(netCoreView({ ...current, regionLock: { locked: false } }).tone, "ok");
});

test("出口 A→B→A 计两次变化，并发观测不覆盖历史，空记录不冒充稳定", async t => {
  const dir = await directory(t);
  assert.equal((await readExitHistory(dir)).stable, false);
  const a = "203.0.113.1", b = "203.0.113.2";
  const results = await Promise.all([recordExit(dir, a, { now: 100 }), recordExit(dir, b, { now: 101 }), recordExit(dir, a, { now: 102 })]);
  assert.equal(results[2].changes, 2);
  assert.equal((await readExitHistory(dir, { now: 103 })).samples, 3);
  assert.equal((await recordExit(dir, "999.1.1.1", { now: 104 })).samples, 3);
  assert.equal((await readExitHistory(dir, { now: 99 })).current, null);
});

test("来源 DNS 独立持久化，旧顶层 DNS 只迁移到原 active", async t => {
  const dir = await directory(t);
  const runtime = await createKernelRuntime({ stateDir: dir, env: { CHECKCC_NET_CORE: "0" } });
  const a = await runtime.importNodes([node("a")], { sourceName: "A", proxyServerDns: ["https://a.example.com/dns-query"] });
  await runtime.importNodes([node("b")], { sourceName: "B", proxyServerDns: ["https://b.example.com/dns-query"] });
  await runtime.activateSource(a.sourceId);
  const saved = await loadNodes(dir);
  assert.deepEqual(saved.proxyServerDns, ["https://a.example.com/dns-query"]);
  assert.deepEqual(saved.sources[1].proxyServerDns, ["https://b.example.com/dns-query"]);
  const migrated = migrateStore({ sources: [{ id: "src_a", proxies: [node("a")] }, { id: "src_b", proxies: [node("b")] }], activeId: "src_b", proxyServerDns: ["192.0.2.53"] });
  assert.deepEqual(migrated.sources[0].proxyServerDns, []);
  assert.deepEqual(migrated.sources[1].proxyServerDns, ["192.0.2.53"]);
});

async function fakeRuntime(t, takeover = { prepare: async () => {}, status: () => ({ phase: "idle", closed: [] }) }, { host = false, ipv6Supported = false, nodeExits = {}, nodeDelays = {}, claudeProxy = null, ipv6Fetch = async () => '2001:db8::1', stateDir, guard = null, platform = 'linux', failClosedAction = null, hostProbe = null, observeExitProbe = null, discoverTargets = async () => ({ programs: ['C:/Claude.exe'], packages: [] }) } = {}) {
  const dir = stateDir ?? await directory(t);
  if (hostProbe) await writeFile(path.join(dir, 'host-token'), 'test-token');
  const apiPort = await pickPortBlock(2, { start: 40181 });
  let failNext = false;
  let failedReloads = 0;
  let tunnelActive = true;
  const hostActions = [];
  const coreModes = [];
  const guardSwitches = [];
  let capturedSecret;
  let starts = 0, maxStarts = 0;
  let healthBroken = false, scheduled = null, interfaceAddress = "192.0.2.10", launches = 0, reloads = 0, exitProbes = 0;
  let statusFailures = 0;
  let ipv6Disabled = false;
  let failRestore = false;
  let failDisable = false;
  let selectedNode = null;
  // Claude 守卫组的当前选择：切 REJECT 不应影响固定出口节点。
  let guardSelection = 'CLAUDE-PIN';
  let failedGuardSelections = 0;
  let ipv6ProbeStarts = 0;
  const runtime = await createKernelRuntime({
    stateDir: dir,
    ...(platform ? { platform } : {}),
    takeover,
    claudeProxy,
    discoverTargets,
    exitFetch: async (_url, options) => {
      exitProbes++;
      await observeExitProbe?.(options);
      const country = Object.hasOwn(nodeExits, selectedNode) ? nodeExits[selectedNode] : 'SG';
      if (country === null) throw new Error('test exit timeout');
      if (country instanceof Error) throw country;
      return JSON.stringify({ ip: '203.0.113.20', country_code: country, success: true });
    },
    systemIpv6: {
      disable: async () => {
        if (failDisable === 'throw') throw new Error('test IPv6 disable failed');
        if (failDisable === 'reason') return { changed: false, reason: 'test IPv6 disable unconfirmed' };
        ipv6Disabled = true;
        return { changed: true, service: 'test', previous: 'Automatic' };
      },
      restore: async () => { if (failRestore) throw new Error('test IPv6 restore failed'); ipv6Disabled = false; return true; },
    },
    ipv6Fetch,
    env: { CHECKCC_NET_CORE_BINARY: process.execPath, CHECKCC_NET_CORE_TUN: "0", CHECKCC_NET_CORE_DNS: "https://192.0.2.53/dns-query",
      CHECKCC_NET_CORE_API_PORT: String(apiPort), CHECKCC_NET_CORE_MIXED_PORT: String(apiPort + 1),
      ...(host && !hostProbe ? { CHECKCC_NET_CORE_HOST: "http://127.0.0.1:39091", CHECKCC_NET_CORE_HOST_TOKEN: "test-host-token" } : {}),
    },
    fetchImpl: async (_url, options) => {
      if (hostProbe && String(_url).endsWith('/health')) return hostProbe();
      if (String(_url).endsWith('/health')) return { ok: true, json: async () => ({ ok: true, running: !healthBroken, hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES, ...(guard ? { guard: { ...guard } } : {}) }) };
      if (options.body) {
        const action = JSON.parse(options.body);
        hostActions.push(action);
        if (action.action === 'claude-guard') {
          await failClosedAction?.(action);
          return { ok: true, json: async () => ({ ok: true, claudeGuard: { armed: action.op === 'arm', directProtected: action.op === 'arm' || action.keepDirect === true, count: action.op === 'arm' ? 2 : 0 } }) };
        }
      }
      return { ok: true, json: async () => ({ ok: true, ...(options.body && JSON.parse(options.body).action === 'ipv6' ? { changed: true, previous: 'Off' } : {}), ...(guard ? { guard: { ...guard } } : {}) }) };
    },
    interfaces: () => (interfaceAddress ? { test: [{ address: interfaceAddress, internal: false }] } : {}),
    healthScheduler: { every: callback => { scheduled = callback; return { unref() {} }; }, clear: () => { scheduled = null; } },
    createCore: options => {
      // 能力探测不访问真实节点，也不操作系统 IPv6。
      if (options.configPath.endsWith("probe.yaml")) return { start: async () => { ipv6ProbeStarts++; if (!ipv6Supported) throw new Error("test probe disabled"); }, stop: async () => {} };
      coreModes.push(options.manageProcess);
      capturedSecret = options.secret;
      let running = false, config;
      // 守卫组选择与固定出口节点分开记：切 REJECT 不应该影响出口选择。
      const proxiesState = () => ({ 'CLAUDE-PIN': { type: 'Selector', now: selectedNode }, 'CLAUDE-GUARD': { type: 'Selector', now: guardSelection } });
      return {
        start: async () => {
          starts++; maxStarts = Math.max(maxStarts, starts);
          try {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (failNext) { const error = failNext; failNext = false; throw error instanceof Error ? error : new Error("injected launch failure"); }
            config = yaml(await readFile(options.configPath, "utf8"));
            selectedNode = config['proxy-groups'][0].proxies[0];
            guardSelection = 'CLAUDE-PIN';
            running = true;
            healthBroken = false;
            launches++;
          } finally { starts--; }
        },
        stop: async () => { running = false; },
        state: () => ({ running: running && !healthBroken }),
        status: async () => {
          if (!running || healthBroken) throw new Error("not running");
          if (statusFailures > 0) { statusFailures--; throw new Error('controller timeout'); }
          return { version: "test", connections: [], proxies: { proxies: proxiesState() } };
        },
        request: async url => {
          if (url === '/configs') return config;
          if (url === '/proxies') return { proxies: proxiesState() };
          const name = decodeURIComponent(url.split('/')[2] ?? '');
          return { delay: Object.hasOwn(nodeDelays, name) ? nodeDelays[name] : 1 };
        },
        selectProxy: async (group, name) => {
          if (group === 'CLAUDE-GUARD' && failedGuardSelections > 0) { failedGuardSelections--; throw new Error('test guard unavailable'); }
          if (group === 'CLAUDE-GUARD') { guardSwitches.push(name); guardSelection = name; return true; }
          config['proxy-groups'][0].proxies = [name]; selectedNode = name;
        },
        tunnelStatus: async () => { if (tunnelActive instanceof Error) throw tunnelActive; return { active: tunnelActive }; },
        reloadFromFile: async () => {
          reloads++;
          config = yaml(await readFile(options.configPath, "utf8"));
          if (failedReloads > 0) { failedReloads--; throw new Error("injected reload failure"); }
        },
      };
    },
  });
  t.after(() => runtime.stop());
  return { runtime, dir, fail: (error = true) => { failNext = error; }, secret: () => capturedSecret, maximum: () => maxStarts,
    failReload: (count = 1) => { failedReloads = count; }, hostActions, coreModes, guardSwitches,
    failGuard: () => { failedGuardSelections++; },
    setTunnelActive: value => { tunnelActive = value; },
    tick: async () => { await scheduled?.(); }, disconnect: () => { healthBroken = true; },
    failStatus: (count = 1) => { statusFailures = count; },
    switchNetwork: () => { interfaceAddress = "192.0.2.11"; }, launches: () => launches,
    offline: () => { interfaceAddress = null; }, online: () => { interfaceAddress = "192.0.2.12"; },
    ipv6Disabled: () => ipv6Disabled, setIpv6Supported: value => { ipv6Supported = value; },
    guard: () => guardSelection, exitProbes: () => exitProbes, reloads: () => reloads, ipv6ProbeStarts: () => ipv6ProbeStarts,
    failIpv6Restore: value => { failRestore = value; },
    failIpv6Disable: value => { failDisable = value; },
  };
}

test('Windows 目标识别失败不拆旧隧道；重试刷新客户端路径', async t => {
  let mode = 'ok';
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32', discoverTargets: async () => {
    if (mode === 'error') throw new Error('discovery timeout');
    return { packages: [], programs: mode === 'empty' ? [] : [`C:/${mode}/Claude.exe`] };
  } });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  for (mode of ['error']) {
    f.hostActions.length = 0;
    await assert.rejects(f.runtime.restart(), /discovery timeout|未找到 Claude/);
    assert.equal(f.hostActions.some(action => action.action === 'stop'), false);
  }
  mode = 'updated';
  f.hostActions.length = 0;
  assert.equal(await f.runtime.restart(), true);
  assert.ok(f.hostActions.some(action => action.op === 'arm' && action.programs.includes('C:/updated/Claude.exe')));
});

test('明确未安装桌面客户端可启动和重启浏览器保护，不误报桌面规则失败', async t => {
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32', discoverTargets: async () => ({ packages: [], programs: [] }) });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  assert.equal(await f.runtime.restart(), true);
  assert.equal(f.hostActions.some(action => action.action === 'ipv6' && action.enabled === false), false, 'Windows 不应为 Claude 禁用整机 IPv6');
  assert.ok(f.hostActions.some(action => action.op === 'arm' && action.domains.includes('claude.ai') && action.programs.length === 0));
  const report = await f.runtime.report();
  assert.equal(report.failClosed.hostGuard.scope, 'browser');
  report.failClosed.hostGuard.directProtected = false;
  report.failClosed.hostGuard.desired = 'protected';
  const view = netCoreView(report);
  assert.doesNotMatch(view.conclusion.detail, /内核缺位阻断未生效/);
  assert.match(view.conclusion.detail, /当前保护浏览器/);
  await f.runtime.stop();
});

test('Windows 重启先布防后停内核，失败期间保持阻断，成功只允许隧道', async t => {
  let deny = false;
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32', failClosedAction: async action => {
    if (deny && action.op === 'arm') throw new Error('firewall unavailable');
  } });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  f.hostActions.length = 0;
  deny = true;
  await assert.rejects(f.runtime.restart(), /firewall unavailable/);
  assert.equal(f.hostActions.some(action => action.action === 'stop'), false, '布防失败不能拆掉旧隧道');
  deny = false;
  f.hostActions.length = 0;
  assert.equal(await f.runtime.restart(), true);
  const armed = f.hostActions.findIndex(action => action.action === 'claude-guard' && action.op === 'arm');
  const stopped = f.hostActions.findIndex(action => action.action === 'stop');
  assert.ok(armed >= 0 && stopped > armed);
  assert.ok(f.hostActions.filter(action => action.op === 'release').every(action => action.keepDirect === true));
  f.hostActions.length = 0;
  f.fail();
  await assert.rejects(f.runtime.restart(), /launch failure/);
  assert.equal(f.hostActions.some(action => action.op === 'release'), false);
  assert.equal((await f.runtime.report()).failClosed.hostGuard.desired, 'armed');
  await f.tick();
  assert.equal((await f.runtime.report()).failClosed.hostGuard.directProtected, true, '重建失败后自动恢复，无需手动开始');
  f.hostActions.length = 0;
  await f.runtime.stop();
  const finalStop = f.hostActions.findIndex(action => action.action === 'stop');
  const release = f.hostActions.findIndex(action => action.op === 'release' && action.keepDirect === false);
  assert.ok(finalStop >= 0 && release > finalStop, '明确停止在内核停止后才解除常驻规则');
});

test('Windows 内核意外退出且断网时保持系统阻断，网络恢复后才允许隧道', async t => {
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32' });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  assert.equal((await f.runtime.report()).failClosed.hostGuard.directProtected, true);
  f.disconnect(); f.offline();
  f.hostActions.length = 0;
  await f.tick();
  assert.ok(f.hostActions.some(action => action.op === 'arm'));
  assert.equal(f.hostActions.some(action => action.op === 'release'), false);
  f.online();
  await f.tick();
  assert.equal((await f.runtime.report()).failClosed.hostGuard.directProtected, true);
});

test('内核就绪后同步 Claude 代理，停止和启动失败时恢复配置', async t => {
  const calls = [];
  const claudeProxy = {
    apply: async proxy => { calls.push(['apply', proxy]); },
    restore: async () => { calls.push(['restore']); },
  };
  const f = await fakeRuntime(t, undefined, { claudeProxy });
  calls.length = 0;
  await f.runtime.importNodes([node('a')]);
  assert.equal(await f.runtime.start(), true);
  assert.equal(calls[0]?.[0], 'apply');
  assert.match(calls[0][1], /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(calls[0][1], (await f.runtime.report()).localProxy);
  await f.runtime.stop();
  assert.deepEqual(calls.at(-1), ['restore']);
  calls.length = 0;
  f.fail();
  assert.equal(await f.runtime.start(), false);
  assert.equal(calls.some(([action]) => action === 'apply'), false);
  assert.deepEqual(calls.at(-1), ['restore']);
});

test('Claude 代理同步失败时回滚，并允许修复后重试启动', async t => {
  let fail = false;
  let restored = 0;
  const f = await fakeRuntime(t, undefined, { claudeProxy: {
    apply: async () => { if (fail) throw new Error('test Claude settings write failed'); },
    restore: async () => { restored++; },
  } });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  restored = 0;
  fail = true;
  assert.equal(await f.runtime.start(), false);
  assert.equal(restored, 1);
  assert.equal((await f.runtime.report()).state, 'error');
  fail = false;
  assert.equal(await f.runtime.start(), true);
});

test('内核生命周期实际写入当前端口并恢复 Claude 配置', async t => {
  const stateDir = await directory(t);
  const configDir = path.join(stateDir, 'claude');
  const file = path.join(configDir, 'settings.json');
  const original = { env: { HTTP_PROXY: 'http://127.0.0.1:7890' }, model: 'custom' };
  await mkdir(configDir);
  await writeFile(file, JSON.stringify(original));
  const f = await fakeRuntime(t, undefined, { claudeProxy: createClaudeProxySettings({ stateDir, configDir }) });
  await f.runtime.importNodes([node('a')]);
  const configured = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(configured.env.HTTP_PROXY, (await f.runtime.report()).localProxy);
  assert.equal(configured.env.HTTPS_PROXY, configured.env.HTTP_PROXY);
  assert.equal(configured.model, 'custom');
  await f.runtime.stop();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
});

test('Claude 代理恢复失败时保留内核运行以便重试退出', async t => {
  let fail = false;
  const f = await fakeRuntime(t, undefined, { claudeProxy: {
    apply: async () => {},
    restore: async () => { if (fail) throw new Error('test Claude settings restore failed'); },
  } });
  await f.runtime.importNodes([node('a')]);
  assert.equal(await f.runtime.start(), true);
  fail = true;
  await assert.rejects(f.runtime.stop(), /restore failed/);
  assert.equal((await f.runtime.report()).state, 'running');
  fail = false;
  await f.runtime.stop();
});

test('启动时未启用内核也会恢复异常退出遗留的 Claude 代理', async t => {
  const stateDir = await directory(t);
  const configDir = path.join(stateDir, 'claude');
  const file = path.join(configDir, 'settings.json');
  const original = { env: { HTTP_PROXY: 'http://127.0.0.1:7890' } };
  await mkdir(configDir);
  await writeFile(file, JSON.stringify(original));
  const claudeProxy = createClaudeProxySettings({ stateDir, configDir });
  await claudeProxy.apply('http://127.0.0.1:39080');
  const runtime = await createKernelRuntime({ stateDir, env: { CHECKCC_NET_CORE: '0' }, claudeProxy });
  t.after(() => runtime.stop());
  assert.equal(runtime.enabled, false);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
});

test('切换供应商后同名节点不复用旧供应商的测速缓存', async t => {
  const measurements = { 'same-name': 1 };
  const f = await fakeRuntime(t, undefined, { nodeDelays: measurements });
  await f.runtime.importNodes([node('same-name')], { sourceName: 'A' });
  const first = (await f.runtime.report()).activeId;
  await f.runtime.collectDelays(['same-name'], { force: true });
  assert.equal((await f.runtime.report()).delays['same-name'], 1);
  const second = await f.runtime.importNodes([node('same-name')], { sourceName: 'B', activate: false });
  assert.notEqual(first, second.sourceId);
  measurements['same-name'] = 77;
  await f.runtime.activateSource(second.sourceId);
  assert.equal((await f.runtime.report()).delays['same-name'], 77);
});

test('供应商切换按订阅顺序跳过超时、未知和 Claude 不支持的实际出口', async t => {
  const f = await fakeRuntime(t, undefined, {
    nodeExits: { 'Japan-banned': 'HK', 'unknown': 'ZZ', 'Hong-Kong-name': 'TW', 'last': 'US' },
    nodeDelays: { 'timeout': null, 'Hong-Kong-name': 250, 'last': 20 },
  });
  await f.runtime.importNodes([node('original')]);
  const imported = await f.runtime.importNodes(['Japan-banned', 'timeout', 'unknown', 'Hong-Kong-name', 'last'].map(node), { sourceName: 'new', selected: 'last', activate: false });
  await f.runtime.activateSource(imported.sourceId);
  const report = await f.runtime.report();
  assert.equal(report.selected, 'Hong-Kong-name');
  assert.equal(report.regionLock.locked, false);
  const saved = JSON.parse(await readFile(path.join(f.dir, 'net-nodes.json'), 'utf8'));
  assert.equal(saved.selected, 'Hong-Kong-name');
});

test('供应商没有合格节点时恢复原供应商、节点和阻断状态', async t => {
  const f = await fakeRuntime(t, undefined, { nodeExits: { banned: 'HK', failed: null }, nodeDelays: { timeout: null } });
  await f.runtime.importNodes([node('original')]);
  const imported = await f.runtime.importNodes(['banned', 'timeout', 'failed'].map(node), { sourceName: 'bad', activate: false });
  const before = await f.runtime.report();
  const saved = await readFile(path.join(f.dir, 'net-nodes.json'), 'utf8');
  await assert.rejects(f.runtime.activateSource(imported.sourceId), /没有.*Claude.*节点/);
  const after = await f.runtime.report();
  assert.equal(after.activeId, before.activeId);
  assert.equal(after.selected, 'original');
  assert.equal(after.regionLock.locked, false);
  assert.equal(await readFile(path.join(f.dir, 'net-nodes.json'), 'utf8'), saved);
});

test('首次导入并启用供应商同样选择第一个可用且地区受支持的节点', async t => {
  const f = await fakeRuntime(t, undefined, { nodeExits: { first: 'HK', second: 'TW' } });
  const imported = await f.runtime.importNodes(['first', 'second'].map(node));
  assert.equal(imported.selected, 'second');
  assert.equal((await f.runtime.report()).selected, 'second');
});

test('删除当前供应商后接替的供应商也过滤 Claude 不支持地区', async t => {
  const f = await fakeRuntime(t, undefined, { nodeExits: { first: 'HK', second: 'TW' } });
  await f.runtime.importNodes([node('original')]);
  const original = (await f.runtime.report()).activeId;
  await f.runtime.importNodes(['first', 'second'].map(node), { sourceName: 'backup', activate: false });
  await f.runtime.deleteSource(original);
  const report = await f.runtime.report();
  assert.equal(report.selected, 'second');
  assert.equal(report.sources.length, 1);
});

test('供应商筛选失败回滚后仍保持原来的未保护阻断', async t => {
  const f = await fakeRuntime(t, undefined, { host: true, nodeExits: { banned: 'HK' } });
  await f.runtime.importNodes([node('original')]);
  await f.runtime.setTunnel(true);
  await f.runtime.setUnprotectedGuard(true);
  const imported = await f.runtime.importNodes([node('banned')], { sourceName: 'bad', activate: false });
  await assert.rejects(f.runtime.activateSource(imported.sourceId), /没有.*Claude.*节点/);
  assert.equal((await f.runtime.report()).unprotectedGuard.active, true);
  const config = yaml(await readFile(path.join(f.dir, 'net-core/config.yaml'), 'utf8'));
  // 回滚后阻断必须还在，但要走运行时守卫组，而不是把 REJECT 写进配置（写配置会全量重载、断掉所有连接）。
  assert.equal(f.guard(), 'REJECT');
  assert.equal(config.rules.includes('DOMAIN-SUFFIX,claude.ai,REJECT'), false);
});

test('后台配置更新支持非强制重载，已有调用保持原重载方式', async t => {
  const dir = await directory(t);
  const configPath = path.join(dir, 'config.yaml');
  await writeFile(configPath, 'proxy-groups: []\n');
  const calls = [];
  const core = createNetCore({
    binary: process.execPath, homeDir: dir, configPath,
    fetchImpl: async url => {
      calls.push(new URL(url).search);
      return { ok: true, status: 200, text: async () => '{"proxies":{}}' };
    },
  });
  await core.reloadFromFile({ force: false });
  assert.ok(calls.includes('?force=false'));
  await core.reloadFromFile();
  assert.ok(calls.includes('?force=true'));
});

test('内核测速请求传播退出取消信号', async () => {
  const controller = new AbortController();
  const core = createNetCore({
    binary: process.execPath, homeDir: tmpdir(), configPath: path.join(tmpdir(), 'unused.yaml'),
    fetchImpl: async (_url, { signal }) => {
      controller.abort();
      assert.equal(signal.aborted, true, '测速请求必须收到调用方取消信号');
      throw controller.signal.reason;
    },
  });
  await assert.rejects(core.request('/proxies/a/delay', { signal: controller.signal }), { name: 'AbortError' });
});

test('复用已开启的隧道不重载内核，启动出口证据只在当前网络短暂复用', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  const reloads = f.reloads();
  await f.runtime.setTunnel(true);
  assert.equal(f.reloads(), reloads, '重复开启不应重载隧道');
  await f.runtime.probeSelectedExit();
  const probes = f.exitProbes();
  await f.runtime.probeSelectedExit({ reuseMs: 5000 });
  assert.equal(f.exitProbes(), probes);
  f.switchNetwork();
  await f.runtime.probeSelectedExit({ reuseMs: 5000 });
  assert.equal(f.exitProbes(), probes + 1, '切网后必须重新验证');
});

test('慢 IPv6 探测不阻塞开启保护，退出取消探测并恢复系统设置', async t => {
  let finishProbe;
  const probeStarted = new Promise(resolve => { finishProbe = resolve; });
  let cancelled = false;
  let abortProbe = () => {};
  t.after(() => abortProbe());
  const f = await fakeRuntime(t, undefined, {
    ipv6Supported: true,
    ipv6Fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      abortProbe = () => reject(new Error('test cleanup'));
      finishProbe();
      signal?.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
    }),
  });
  await f.runtime.importNodes([node('a')]);
  const starting = f.runtime.setTunnel(true);
  const ready = await Promise.race([starting.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
  // Always release the intentionally blocked fake probe, including on regression.
  if (!ready) { f.runtime.cancelPending?.(); throw new Error('IPv6 探测阻塞了保护启动'); }
  await probeStarted;
  assert.equal(f.ipv6Disabled(), true, '探测期间必须阻断 IPv6 旁路');
  await f.runtime.stop();
  assert.equal(cancelled, true);
  assert.equal(f.ipv6Disabled(), false);
});

async function waitForIpv6(runtime) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await runtime.report()).ipv6?.protected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('后台 IPv6 探测没有完成安全接管');
}

test('IPv6 能力缓存跨重启复用，网络变化后重新后台探测', async t => {
  const first = await fakeRuntime(t, undefined, { ipv6Supported: true });
  await first.runtime.importNodes([node('a')]);
  await first.runtime.setTunnel(true);
  await waitForIpv6(first.runtime);
  await first.runtime.stop();
  const second = await fakeRuntime(t, undefined, { ipv6Supported: true, stateDir: first.dir });
  await second.runtime.start();
  await second.runtime.setTunnel(true);
  assert.equal(second.ipv6ProbeStarts(), 0, '同一节点、网络和有效期内不再启动临时内核');
  assert.equal((await second.runtime.report()).ipv6.protected, true);
  second.switchNetwork();
  await second.runtime.setTunnel(true);
  await waitForIpv6(second.runtime);
  assert.equal(second.ipv6ProbeStarts(), 1);
});

test('IPv6 支持时启用双栈，换到未确认节点时关闭系统 IPv6，停止时恢复', async t => {
  const f = await fakeRuntime(t, undefined, { ipv6Supported: true });
  await f.runtime.importNodes([node('a'), node('b')]);
  await f.runtime.setTunnel(true);
  await waitForIpv6(f.runtime);
  let config = yaml(await readFile(path.join(f.dir, 'net-core/config.yaml'), 'utf8'));
  assert.equal(config.ipv6, true);
  assert.equal(f.ipv6Disabled(), false);
  assert.equal((await f.runtime.report()).ipv6.protected, true);
  f.setIpv6Supported(false);
  await f.runtime.select('b');
  config = yaml(await readFile(path.join(f.dir, 'net-core/config.yaml'), 'utf8'));
  assert.equal(config.ipv6, false);
  assert.equal(f.ipv6Disabled(), true);
  const report = await f.runtime.report();
  assert.equal(report.ipv6.supported, null);
  assert.equal(report.ipv6.system, 'disabled');
  assert.equal(report.ipv6.protected, false);
  await f.runtime.stop();
  assert.equal(f.ipv6Disabled(), false);
});

test('IPv6 恢复失败明确报错，内核已停止后仍可重试恢复', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  f.failIpv6Restore(true);
  await assert.rejects(f.runtime.stop(), /IPv6 restore failed/);
  assert.equal(f.ipv6Disabled(), true);
  f.failIpv6Restore(false);
  await f.runtime.stop();
  assert.equal(f.ipv6Disabled(), false);
});

test('关闭 IPv6 抛错或未确认时拒绝启用保护并保留原隧道状态', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  for (const failure of ['throw', 'reason']) {
    f.failIpv6Disable(failure);
    await assert.rejects(f.runtime.setTunnel(true), /IPv6 disable/);
    assert.equal((await f.runtime.report()).tunEnabled, false);
    const config = yaml(await readFile(path.join(f.dir, 'net-core/config.yaml'), 'utf8'));
    assert.equal(config.tun.enable, false);
  }
});

test('换节点的 IPv6 热加载失败时恢复原选择、配置和保护状态', async t => {
  const f = await fakeRuntime(t, undefined, { ipv6Supported: true });
  await f.runtime.importNodes([node('a'), node('b')]);
  await f.runtime.setTunnel(true);
  await waitForIpv6(f.runtime);
  f.failReload();
  await assert.rejects(f.runtime.select('b'), /injected reload failure/);
  const report = await f.runtime.report();
  assert.equal(report.selected, 'a');
  assert.equal(report.ipv6.protected, true);
  const config = yaml(await readFile(path.join(f.dir, 'net-core/config.yaml'), 'utf8'));
  assert.equal(config['proxy-groups'][0].proxies[0], 'a');
  assert.equal(config.ipv6, true);
});

test("已有代理启用 TUN 前先交接，冲突时保留原代理配置与未接管状态", async t => {
  let called = 0;
  const f = await fakeRuntime(t, { prepare: async () => { called++; throw new Error("other VPN still connected"); }, status: () => ({ phase: "blocked", closed: [], reason: "other VPN still connected" }) });
  await f.runtime.importNodes([node("a")]);
  const before = await readFile(path.join(f.dir, "net-core/config.yaml"), "utf8");
  await assert.rejects(f.runtime.setTunnel(true), /other VPN/);
  assert.equal(called, 1);
  assert.equal(await readFile(path.join(f.dir, "net-core/config.yaml"), "utf8"), before);
  const report = await f.runtime.report();
  assert.equal(report.tunEnabled, false); assert.equal(report.state, "running");
  assert.equal(report.takeover.phase, "blocked");
});

test("后台串行导入、模式失败回滚及控制器密钥不下发", async t => {
  const f = await fakeRuntime(t);
  await Promise.all([f.runtime.importNodes([node("a")]), f.runtime.importNodes([node("b")])]);
  assert.equal(f.maximum(), 1);
  const before = await f.runtime.report();
  assert.equal(before.sources.length, 2);
  assert.equal(before.tunEnabled, false);
  await assert.rejects(f.runtime.verifyConnection(), /未启用/);
  await assert.rejects(f.runtime.setStrictMode(true), /特权宿主/);
  assert.equal((await f.runtime.report()).strictMode, false);
  assert.ok(f.secret().length >= 32);
  assert.ok(!JSON.stringify(before).includes(f.secret()));
  const config = yaml(await readFile(path.join(f.dir, "net-core/config.yaml"), "utf8"));
  assert.equal(config.secret, f.secret());
  f.failReload();
  await assert.rejects(f.runtime.setMode("global"), /injected/);
  const after = await f.runtime.report();
  assert.equal(after.mode, "rule");
  assert.equal(after.state, "running");
  assert.equal(f.runtime.connectionState().systemKillSwitch, false);
});

test("代理范围热加载不重启内核，宿主 TUN 不重复交接自己的端口", async t => {
  for (const host of [false, true]) {
    let takeovers = 0;
    const f = await fakeRuntime(t, {
      prepare: async () => {
        if (++takeovers > 1) throw new Error("端口 39090 仍被其他程序占用");
      },
      status: () => ({ phase: "ready", closed: [] }),
    }, { host });
    await f.runtime.importNodes([node("a")]);
    if (host) await f.runtime.setTunnel(true);
    const launches = f.launches(), actions = f.hostActions.length;
    for (const mode of ["global", "direct", "rule"]) {
      await f.runtime.setMode(mode);
      const report = await f.runtime.report();
      assert.equal(report.mode, mode);
      assert.equal(report.state, "running");
      assert.equal(report.tunEnabled, host);
      if (host) assert.equal(report.tunCaptured, true);
      assert.equal(JSON.parse(await readFile(path.join(f.dir, "net-core-mode.json"), "utf8")).mode, mode);
      const config = yaml(await readFile(path.join(f.dir, "net-core/config.yaml"), "utf8"));
      assert.equal(config.rules.at(-1), mode === "direct" ? "MATCH,DIRECT" : "MATCH,AUTO-PROXY");
      assert.equal(config.tun.enable, host);
    }
    assert.equal(f.launches(), launches);
    assert.equal(f.hostActions.length, actions);
    assert.equal(takeovers, host ? 1 : 0);
  }
});

test("代理范围部分重载失败恢复已保存模式和规则，恢复失败如实报告", async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node("a")]);
  await f.runtime.setMode("global");
  const file = path.join(f.dir, "net-core-mode.json");
  const before = await readFile(file, "utf8");
  const configFile = path.join(f.dir, "net-core/config.yaml");
  const config = await readFile(configFile, "utf8");
  const launches = f.launches();
  f.failReload();
  await assert.rejects(f.runtime.setMode("direct"), /injected reload failure/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(await readFile(configFile, "utf8"), config);
  assert.equal((await f.runtime.report()).state, "running");
  assert.equal((await f.runtime.report()).mode, "global");
  assert.equal(f.launches(), launches);
  f.failReload(2);
  await assert.rejects(f.runtime.setMode("direct"), /回滚失败/);
  assert.equal((await f.runtime.report()).state, "error");
});

test("代理范围重载后隧道失效不能返回切换成功", async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node("a")]);
  await f.runtime.setTunnel(true);
  f.setTunnelActive(false);
  await assert.rejects(f.runtime.setMode("global"), /隧道未接管/);
  const report = await f.runtime.report();
  assert.equal(report.mode, "rule");
  assert.equal(report.state, "error");
  assert.equal(f.runtime.connectionState().tunCaptured, null);
});

test("网络异常默认只阻断 Claude；严格断流需显式开启并落盘", async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node("a")]);
  assert.equal((await f.runtime.report()).networkFailurePolicy, "claude", "默认只阻断 Claude，不封全部网络");
  await f.runtime.setNetworkFailurePolicy("all");
  assert.equal((await f.runtime.report()).networkFailurePolicy, "all");
  await assert.rejects(f.runtime.setNetworkFailurePolicy("everything"), /claude 或 all/);
  const saved = JSON.parse(await readFile(path.join(f.dir, "net-core-guard-policy.json"), "utf8"));
  assert.equal(saved.networkFailure, "all", "选择必须落盘，重启后保持");
  await f.runtime.setNetworkFailurePolicy("claude");
  assert.equal((await f.runtime.report()).networkFailurePolicy, "claude");
});

test("Windows 未保护阻断不启动 TUN、不重载普通代理", async t => {
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32' });
  await f.runtime.importNodes([node("a")]);
  const launches = f.launches();
  await f.runtime.setUnprotectedGuard(true);
  const blocked = await f.runtime.report();
  assert.equal(blocked.unprotectedGuard?.active, true);
  assert.equal(blocked.tunEnabled, false);
  assert.equal(f.guard(), 'REJECT');
  assert.equal(f.launches(), launches);
  await f.runtime.setTunnel(false);
  assert.equal((await f.runtime.report()).state, 'running');
  await f.runtime.setUnprotectedGuard(false);
  assert.equal((await f.runtime.report()).unprotectedGuard, null);
});

test("独立阻断失败不影响普通代理运行或切换节点", async t => {
  const f = await fakeRuntime(t, undefined, { host: true, platform: 'win32', failClosedAction: async action => { if (action.op === 'arm') throw new Error('test firewall unavailable'); } });
  await f.runtime.importNodes([node("a")]);
  await assert.rejects(f.runtime.setUnprotectedGuard(true), /firewall unavailable/);
  await f.runtime.setTunnel(false);
  await f.runtime.importNodes([node("b")]);
  const report = await f.runtime.report();
  assert.equal(report.unprotectedGuard, null);
  assert.equal(report.tunEnabled, false);
  assert.equal(report.state, 'running');
});

test("节点配置启动失败恢复旧文件，不能返回导入成功", async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node("a")]);
  const before = await readFile(path.join(f.dir, "net-nodes.json"), "utf8");
  f.fail();
  await assert.rejects(f.runtime.importNodes([node("b")]), /injected/);
  assert.equal(await readFile(path.join(f.dir, "net-nodes.json"), "utf8"), before);
  assert.deepEqual((await f.runtime.report()).nodes, ["a"]);
  assert.equal((await f.runtime.report()).state, "running");
});

test("网络抖动只阻断 Claude，不重建内核（重建会断掉全部流量且耗时长）", async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node("a")]);
  await f.runtime.setTunnel(true);
  const launches = f.launches();
  // 模拟断网 1 秒：隧道探测失败，但内核进程本身是好的。
  f.setTunnelActive(false);
  await f.tick();
  assert.equal(f.launches(), launches, "网络抖动不得重建内核");
  assert.equal(f.guard(), "REJECT", "抖动期间只阻断 Claude");
  assert.equal((await f.runtime.report()).regionLock?.type, "network", "按自动复检的网络锁处理");
  // 网络恢复：出口复检通过就立刻放行，全程不重启内核。
  f.setTunnelActive(true);
  const released = await f.runtime.unlockRegion();
  assert.equal(released.exit?.countryCode, "SG");
  assert.equal(f.guard(), "CLAUDE-PIN");
  assert.equal(f.launches(), launches, "放行同样不重建内核");
});

test("网络波动恢复后两秒内自动复检放行，不等待旧的三十秒周期", async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node("a")]);
  await f.runtime.setTunnel(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.setTunnelActive(false);
  await f.tick();
  assert.equal(f.guard(), 'REJECT');
  f.setTunnelActive(true);
  t.mock.timers.tick(2000);
  await f.tick();
  assert.equal(f.guard(), 'CLAUDE-PIN', '恢复后自动复检放行，无需手动解锁或重启');
  assert.equal(f.launches(), launches);
});

test("出口连续探测失败后前五分钟每两秒复检，恢复即自动放行", async t => {
  const exits = { a: 'SG' };
  const f = await fakeRuntime(t, undefined, { nodeExits: exits });
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  exits.a = null;
  f.switchNetwork();
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.tick();
    assert.equal(f.guard(), 'REJECT');
    t.mock.timers.tick(2000);
  }
  exits.a = 'SG';
  await f.tick();
  assert.equal(f.guard(), 'CLAUDE-PIN', '恢复窗口内不得因失败退避拖延放行');
  assert.equal(f.launches(), launches);
});

test("出口检测服务报错不应误判断网并阻断 Claude", async t => {
  const exits = { a: 'SG' };
  const f = await fakeRuntime(t, undefined, { host: true, nodeExits: exits });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  exits.a = new Error('HTTP 429 Too Many Requests');
  f.switchNetwork();
  await f.tick();
  assert.equal(f.guard(), 'CLAUDE-PIN');
  assert.equal((await f.runtime.report()).regionLock?.locked, false);
});

test("守卫切换失败写入兜底 REJECT 后，恢复必须清除规则", async t => {
  const exits = { a: 'SG' };
  const f = await fakeRuntime(t, undefined, { nodeExits: exits });
  await f.runtime.importNodes([node('a')]);
  f.failGuard();
  exits.a = null;
  f.switchNetwork();
  await f.tick();
  const configPath = path.join(f.dir, 'net-core/config.yaml');
  assert.ok(yaml(await readFile(configPath, 'utf8')).rules.includes('DOMAIN-SUFFIX,claude.ai,REJECT'));
  exits.a = 'SG';
  f.failReload();
  await assert.rejects(f.runtime.unlockRegion(), /injected reload failure/);
  assert.equal((await f.runtime.report()).regionLock?.locked, true, '放行失败后必须保留锁以便下一轮重试');
  await f.runtime.unlockRegion();
  assert.equal(yaml(await readFile(configPath, 'utf8')).rules.includes('DOMAIN-SUFFIX,claude.ai,REJECT'), false);
  assert.equal(f.guard(), 'CLAUDE-PIN');
});

test("断网超过五分钟后降低复检频率，首轮成功即放行", async t => {
  const exits = { a: 'SG' };
  const f = await fakeRuntime(t, undefined, { nodeExits: exits });
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  exits.a = null;
  f.switchNetwork();
  await f.tick();
  // 持续巡检，不能把时间跳跃误当成休眠唤醒并重置恢复窗口。
  for (let second = 0; second < 300; second++) { t.mock.timers.tick(1000); await f.tick(); }
  const probes = f.exitProbes();
  exits.a = 'SG';
  t.mock.timers.tick(1000);
  await f.tick();
  assert.equal(f.exitProbes(), probes, '五分钟后不再维持高频探测');
  for (let second = 0; second < 30; second++) { t.mock.timers.tick(1000); await f.tick(); }
  assert.equal(f.guard(), 'CLAUDE-PIN');
});

test("后台脱离页面恢复内核，切网使旧证据失效，显式停止后不自动重启", async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node("a")]);
  const previous = f.launches();
  f.disconnect();
  await f.tick();
  assert.equal(f.launches(), previous + 1);
  assert.equal((await f.runtime.report()).state, "running");
  const generation = f.runtime.connectionState().networkGeneration;
  f.switchNetwork();
  await f.tick();
  assert.equal(f.runtime.connectionState().networkGeneration, generation + 1);
  await f.runtime.stop();
  const stopped = f.launches();
  await f.tick();
  assert.equal(f.launches(), stopped);
  assert.equal(f.runtime.connectionState().state, "off");
});

test("特权宿主拒绝符号链接、无密钥与外部文件配置", async t => {
  const dir = await directory(t);
  await mkdir(path.join(dir, "net-core"));
  const file = path.join(dir, "net-core/config.yaml");
  await writeFile(file, stringify({ mode: "direct", secret: "x".repeat(64) }));
  assert.equal((await readHostConfig(dir, file)).mode, "direct");
  await writeFile(file, "mode: direct\n");
  await assert.rejects(readHostConfig(dir, file), /密钥/);
  await writeFile(file, stringify({ secret: "x".repeat(64), "external-ui": "/private" }));
  await assert.rejects(readHostConfig(dir, file), /配置字段/);
  if (process.platform !== "win32") {
    const outside = path.join(dir, "outside.yaml");
    await writeFile(outside, stringify({ secret: "x".repeat(64) }));
    await rm(file);
    await symlink(outside, file);
    await assert.rejects(readHostConfig(dir, file), /符号链接|逃逸/);
  }
});

test("配置重载先编译原选择，缺少原节点时不发送配置，恢复失败不报成功", async t => {
  const dir = await directory(t);
  const file = path.join(dir, "config.yaml");
  await writeFile(file, stringify({ rules: ["MATCH,DIRECT"], "proxy-groups": [{ name: "CLAUDE-PIN", type: "select", proxies: ["a", "b"] }] }));
  let loaded = null, wrongSelection = false;
  const core = createNetCore({ binary: process.execPath, homeDir: dir, configPath: file, manageProcess: false,
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname;
      let value = { version: "test" };
      if (route === "/proxies") value = { proxies: { "CLAUDE-PIN": { type: "Selector", now: "b" }, GLOBAL: { type: "Selector", now: "a" } } };
      if (route === "/configs" && options.method === "PUT") loaded = yaml(JSON.parse(options.body).payload);
      if (route === "/proxies/CLAUDE-PIN") value = { now: wrongSelection ? "a" : "b" };
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    },
  });
  await core.start();
  assert.equal(await core.reloadFromFile(), 1);
  assert.deepEqual(loaded["proxy-groups"][0].proxies, ["b", "a"]);
  loaded = null;
  await writeFile(file, stringify({ rules: ["MATCH,DIRECT"], "proxy-groups": [{ name: "CLAUDE-PIN", type: "select", proxies: ["a"] }] }));
  await assert.rejects(core.reloadFromFile(), /原节点/);
  assert.equal(loaded, null);
  await writeFile(file, stringify({ rules: ["MATCH,DIRECT"], "proxy-groups": [{ name: "CLAUDE-PIN", type: "select", proxies: ["a", "b"] }] }));
  wrongSelection = true;
  await assert.rejects(core.reloadFromFile(), /未保持原出口/);
  assert.equal(core.state().running, false);
  await core.stop();
});

test("网络验证失败不应用环境，恢复失败保留会话备份", async t => {
  const dir = await directory(t);
  const calls = [];
  let networkFails = true, releaseFails = false;
  const session = new ProtectionSession({ stateDir: dir,
    beforeActivate: async () => { calls.push("network"); if (networkFails) throw new Error("tunnel failed"); },
    beforeTest: async () => {},
    detect: async () => { calls.push("detect"); return { ip: "203.0.113.1", language: "en-US", locale: "en-US" }; },
    snapshot: async () => ({}), apply: async () => { calls.push("apply"); return []; },
    restore: async () => { calls.push("restore"); return []; }, test: async () => ({ state: "passed" }),
    afterStop: async () => { calls.push("release"); if (releaseFails) throw new Error("release failed"); },
  });
  await assert.rejects(session.start("http://localhost:3000"), /tunnel failed/);
  assert.deepEqual(calls, ["network", "release"]);
  assert.equal(session.report().enabled, false);
  networkFails = false;
  await session.start("http://localhost:3000");
  assert.ok(calls.indexOf("network") < calls.indexOf("apply"));
  releaseFails = true;
  assert.equal((await session.stop()).phase, "restore_failed");
  assert.ok(await readFile(path.join(dir, "protection-session.json"), "utf8"));
  releaseFails = false;
  assert.equal((await session.stop()).phase, "idle");
  assert.ok(calls.lastIndexOf("restore") < calls.lastIndexOf("release"));
});

test("特权启动脚本清理 Node 注入环境并拒绝 Windows 批处理展开路径", () => {
  const mac = buildHostInstallPlan({ platform: "darwin", nodePath: "/protected/node", hostScript: "/protected/host.mjs", stateDir: "/state/$(touch unwanted)", binary: "/protected/mihomo" });
  assert.match(mac.files[0].content, /env -i/);
  assert.ok(mac.files[0].content.includes("'/state/$(touch unwanted)'"));
  const win = buildHostInstallPlan({ platform: "win32", nodePath: "C:\\Protected\\node.exe", hostScript: "C:\\Protected\\host.mjs", stateDir: "C:\\State", binary: "C:\\Protected\\mihomo.exe" });
  assert.match(win.files[0].content, /NODE_OPTIONS=/);
  assert.ok(win.commands.some(command => command.cmd === "icacls.exe" && command.args.includes("/setowner")));
  assert.throws(() => buildHostInstallPlan({ platform: "win32", nodePath: "C:\\%evil%\\node.exe", hostScript: "C:\\host.mjs", stateDir: "C:\\State", binary: "C:\\mihomo.exe" }), /百分号/);
});

test("宿主安装使用独立运行包，来源文件替换不影响已安装内容", async t => {
  const dir = await directory(t);
  const sourceNode = path.join(dir, "source-node");
  const sourceKernel = path.join(dir, "source-kernel");
  await writeFile(sourceNode, "original-node");
  await writeFile(sourceKernel, "original-kernel");
  const calls = [];
  const destination = path.join(await import("node:fs/promises").then(fs => fs.realpath(dir)), "protected");
  const installed = await stageHostBundle({
    hostScript: fileURLToPath(new URL("./net-core/host.mjs", import.meta.url)), binary: sourceKernel,
    nodePath: sourceNode, destination, platform: "darwin",
    run: async (command, args) => { calls.push([command, args]); },
  });
  await writeFile(sourceNode, "changed");
  await writeFile(sourceKernel, "changed");
  assert.equal(await readFile(installed.nodePath, "utf8"), "original-node");
  assert.equal(await readFile(installed.binary, "utf8"), "original-kernel");
  assert.ok(installed.hostScript.startsWith(destination + path.sep));
  assert.ok((await readFile(path.join(installed.root, "node_modules/yaml/package.json"), "utf8")).includes('"yaml"'));
  assert.ok(calls.some(([command]) => command.endsWith("chown")));
});

test("断网期间不重建内核，网络恢复后立即重建（不再反复启动失败）", async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node("a")]);
  assert.equal(await f.runtime.start(), true);
  const launches = f.launches();
  // 网卡消失 + 内核进程挂掉：此刻重建必然失败，只应进入等待。
  f.offline();
  f.disconnect();
  await f.tick();
  assert.equal(f.launches(), launches, "断网期间不得重建内核");
  const waiting = await f.runtime.report();
  assert.equal(waiting.state, "offline", "断网要显示等待网络，而不是启动失败");
  assert.match(waiting.reason, /网络已断开/);
  assert.equal(waiting.network.offline, true);
  assert.equal(waiting.network.links, 0);
  // 网络恢复（接口变化）：立刻重建，不等退避窗口。
  f.online();
  await f.tick();
  assert.equal(f.launches(), launches + 1, "网络恢复后应立即重建内核");
  assert.notEqual((await f.runtime.report()).state, "offline");
});

test('断网启动失败后建立后台重试，联网后自动拉起', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  const launches = f.launches();
  f.offline(); f.fail();
  assert.equal(await f.runtime.start(), false);
  await f.tick();
  assert.equal(f.launches(), launches, '无网时只等待');
  f.online(); await f.tick();
  assert.equal(f.launches(), launches + 1, '恢复网络后无需手动启动');
  assert.equal((await f.runtime.report()).state, 'running');
});

test('等待网络恢复时显式停止，联网和唤醒都不能重新拉起', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  f.offline(); f.fail();
  assert.equal(await f.runtime.start(), false);
  await f.runtime.stop();
  const launches = f.launches();
  f.online(); await f.tick();
  assert.equal(f.launches(), launches);
  assert.equal((await f.runtime.report()).state, 'idle');
});

test('单次控制接口超时保持内核运行，下一轮正常即清除错误', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  const launches = f.launches();
  f.failStatus(); await f.tick();
  assert.equal(f.launches(), launches, '进程存活时不因单次超时重建');
  await f.tick();
  assert.equal((await f.runtime.report()).state, 'running');
  assert.equal(f.launches(), launches);
});

test('隧道持续失败超过五分钟只阻断 Claude，不重建存活内核', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.setTunnelActive(new Error('隧道解析探测超时。'));
  for (let second = 0; second < 620; second++) { t.mock.timers.tick(1000); await f.tick(); }
  assert.equal(f.launches(), launches);
  assert.equal(f.guard(), 'REJECT');
});

test('进程存活时控制接口持续失败超过五分钟仍不重建', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.failStatus(2);
  for (let i = 0; i < 2; i++) { await f.tick(); t.mock.timers.tick(1000); }
  assert.equal(f.launches(), launches);
  await f.tick();
  f.failStatus(Infinity);
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(1000); await f.tick(); }
  assert.equal(f.launches(), launches, '成功探测应清除此前累计');
  t.mock.timers.tick(1000); await f.tick();
  assert.equal(f.launches(), launches, '三次控制接口失败也不能立即重建存活的内核');
  for (let second = 0; second < 298; second++) { t.mock.timers.tick(1000); await f.tick(); }
  assert.equal(f.launches(), launches, '控制接口无响应不能证明进程已退出');
});

test('宿主确认进程已退出后立即恢复，不等待控制接口五分钟窗口', async t => {
  let running = true;
  const f = await fakeRuntime(t, undefined, { host: true, hostProbe: async () => ({ ok: true, json: async () => ({ ok: true, running, hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES }) }) });
  await f.runtime.importNodes([node('a')]);
  const launches = f.launches();
  running = false;
  f.failStatus(Infinity);
  await f.tick();
  assert.equal(f.launches(), launches + 1, '本地 ready 缓存不能掩盖宿主确认的退出');
});

test('宿主确认进程仍在时控制接口失联不能触发重建', async t => {
  const f = await fakeRuntime(t, undefined, { host: true, hostProbe: async () => ({ ok: true, json: async () => ({ ok: true, running: true, hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES }) }) });
  await f.runtime.importNodes([node('a')]);
  const launches = f.launches();
  f.failStatus(Infinity);
  await f.tick();
  assert.equal(f.launches(), launches);
});

test('后台休眠恢复立即复检相同网卡的出口，健康内核不重启', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await f.tick();
  const probes = f.exitProbes(), launches = f.launches();
  t.mock.timers.tick(16000); await f.tick();
  assert.ok(f.exitProbes() > probes, '唤醒立即作废旧证据，不等待三十秒周期');
  assert.equal(f.launches(), launches);
  assert.equal((await f.runtime.report()).state, 'running');
});

test('休眠超过抢修窗口后隧道未就绪，只阻断 Claude 并继续恢复', async t => {
  const nodeExits = {};
  const f = await fakeRuntime(t, undefined, { host: true, nodeExits });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  nodeExits.a = null;
  f.setTunnelActive(false); await f.tick();
  t.mock.timers.tick(10 * 60 * 1000); await f.tick();
  assert.equal(f.launches(), launches, '休眠时间不能耗尽抢修窗口并触发全网重建');
  assert.equal(f.guard(), 'REJECT');
  nodeExits.a = 'SG';
  f.setTunnelActive(true); t.mock.timers.tick(2000); await f.tick();
  assert.equal(f.guard(), 'CLAUDE-PIN');
  assert.equal((await f.runtime.report()).state, 'running');
});

test('休眠唤醒取消重建退避，即使网卡地址未变也马上重试', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.disconnect(); f.fail(); await f.tick();
  // 每秒巡检，重建在第 4、12 秒失败，下次原定第 28 秒。
  for (let i = 0; i < 12; i++) { f.fail(); t.mock.timers.tick(1000); await f.tick(); }
  assert.equal(f.launches(), launches);
  t.mock.timers.tick(15001); await f.tick();
  assert.equal(f.launches(), launches + 1, '后台唤醒不能继续等休眠前的退避');
  assert.equal((await f.runtime.report()).state, 'running');
});

test('唤醒时网络晚于进程恢复，等到网卡上线再重建内核', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.offline(); f.disconnect();
  t.mock.timers.tick(60 * 60 * 1000); await f.tick();
  assert.equal(f.launches(), launches, '唤醒不代表网络已经可用');
  t.mock.timers.tick(1000); await f.tick();
  assert.equal(f.launches(), launches);
  f.online(); t.mock.timers.tick(1000); await f.tick();
  assert.equal(f.launches(), launches + 1);
  assert.equal((await f.runtime.report()).state, 'running');
});

test('网卡仍有 IPv4 的启动网络超时，也会自动重试', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  const launches = f.launches();
  f.fail(new Error('内核就绪超时，请检查内核配置或端口占用。'));
  assert.equal(await f.runtime.start(), false);
  await f.tick();
  assert.equal(f.launches(), launches + 1);
  assert.equal((await f.runtime.report()).state, 'running');
});

test('权限失败不进入自动启动循环', async t => {
  const f = await fakeRuntime(t);
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  const launches = f.launches();
  f.fail(new Error('TUN 需要更高权限'));
  assert.equal(await f.runtime.start(), false);
  await f.tick();
  assert.equal(f.launches(), launches);
  assert.equal((await f.runtime.report()).state, 'error');
});

test('唤醒且内核丢失时，独立恢复工具解除严格模式的意愿优先于自动重建', async t => {
  const saved = await fakeRuntime(t);
  await saved.runtime.importNodes([node('a')]);
  await saved.runtime.stop();
  await writeFile(path.join(saved.dir, 'net-core-strict.json'), JSON.stringify({ enabled: true, baselineIp: '203.0.113.20' }));
  const guard = { supported: true, armed: true, phase: 'active', checkedAt: new Date().toISOString() };
  const f = await fakeRuntime(t, undefined, { stateDir: saved.dir, host: true, platform: 'darwin', guard });
  const started = await f.runtime.start();
  assert.equal(started, true, (await f.runtime.report()).reason);
  await f.runtime.setNetworkFailurePolicy('all');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  Object.assign(guard, { armed: false, phase: 'off' });
  f.disconnect();
  const before = f.hostActions.length;
  t.mock.timers.tick(60000); await f.tick();
  const actions = f.hostActions.slice(before);
  assert.equal(actions[0]?.action, 'guard-status', '任何自动阻断或重建之前先读取显式解除');
  assert.ok(!actions.some(action => action.action === 'start' && action.strict));
  assert.equal((await f.runtime.report()).strictMode, false);
});

test("宿主探测超时不降级成本机模式（否则会自起第二个内核抢 39090/TUN）", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "checkcc-host-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "host-token"), "test-token\n");
  let healthOk = true;
  const runtime = await createKernelRuntime({
    stateDir: dir,
    env: { CHECKCC_NET_CORE: "0" },
    fetchImpl: async url => {
      if (!String(url).endsWith("/health")) throw new Error("unexpected request " + url);
      if (!healthOk) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return { ok: true, json: async () => ({ ok: true, hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES, guard: null }) };
    },
  });
  t.after(() => runtime.stop().catch(() => {}));
  assert.equal((await runtime.report()).hostMode, true, "宿主可用时应进入宿主模式");
  healthOk = false;
  await runtime.refreshHost();
  const after = await runtime.report();
  assert.equal(after.hostMode, true, "探测超时不得降级成本机模式");
  assert.equal(after.hostProbeFailed, true, "界面应能看出是在等宿主");
  healthOk = true;
  await runtime.refreshHost();
  assert.equal((await runtime.report()).hostProbeFailed, false, "宿主恢复后应清除提示");
});

test('真正启动时宿主探测超时，保持宿主模式且恢复后自动重试', async t => {
  let healthy = true;
  const f = await fakeRuntime(t, undefined, { hostProbe: () => {
    if (!healthy) throw new Error('The operation was aborted due to timeout');
    return { ok: true, json: async () => ({ hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES }) };
  } });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.stop();
  const launches = f.launches(), cores = f.coreModes.length;
  healthy = false;
  assert.equal(await f.runtime.start(), false, '宿主探测失败时等待，不尝试本机启动');
  const waiting = await f.runtime.report();
  assert.equal(waiting.hostMode, true);
  assert.equal(waiting.hostProbeFailed, true);
  assert.equal(f.coreModes.length, cores);
  await f.tick();
  assert.equal(f.launches(), launches);
  healthy = true;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60000 });
  await f.tick();
  const recovered = await f.runtime.report();
  assert.equal(recovered.hostMode, true);
  assert.equal(recovered.hostProbeFailed, false);
  assert.equal(recovered.state, 'running');
  assert.equal(f.launches(), launches + 1);
  assert.ok(f.coreModes.every(manageProcess => manageProcess === false));
});

test('后台重建遇到宿主 HTTP 失败也不降级，下一次探测成功清除提示', async t => {
  let healthy = true;
  const f = await fakeRuntime(t, undefined, { hostProbe: () => healthy
    ? { ok: true, json: async () => ({ ok: true, running: false, hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES }) }
    : { ok: false, status: 503 },
  });
  await f.runtime.importNodes([node('a')]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches(), cores = f.coreModes.length;
  healthy = false; f.disconnect(); await f.tick();
  const waiting = await f.runtime.report();
  assert.equal(waiting.hostMode, true);
  assert.equal(waiting.hostProbeFailed, true);
  assert.equal(f.coreModes.length, cores, '后台恢复不能新建本机内核');
  healthy = true; t.mock.timers.tick(4000); await f.tick();
  const recovered = await f.runtime.report();
  assert.equal(recovered.state, 'running');
  assert.equal(recovered.hostMode, true);
  assert.equal(recovered.hostProbeFailed, false);
  assert.equal(f.launches(), launches + 1);
  assert.ok(f.coreModes.every(manageProcess => manageProcess === false));
});

test('应用冷启动时已安装的宿主超时，也只能等待，不能自起本机内核', async t => {
  let healthy = true;
  const hostProbe = () => {
    if (!healthy) throw new Error('The operation was aborted due to timeout');
    return { ok: true, json: async () => ({ hostProtocol: HOST_PROTOCOL, capabilities: HOST_CAPABILITIES }) };
  };
  const seed = await fakeRuntime(t, undefined, { hostProbe });
  await seed.runtime.importNodes([node('a')]);
  await seed.runtime.stop();
  healthy = false;
  const f = await fakeRuntime(t, undefined, { stateDir: seed.dir, hostProbe });
  await assert.rejects(f.runtime.setTunnel(true, { ensureHost: true }), /宿主探测超时/);
  assert.equal(await f.runtime.start(), false);
  assert.equal((await f.runtime.report()).hostProbeFailed, true);
  assert.equal(f.coreModes.length, 0);
  healthy = true; await f.tick();
  assert.equal((await f.runtime.report()).state, 'running');
  assert.equal((await f.runtime.report()).hostProbeFailed, false);
  assert.deepEqual(f.coreModes, [false]);
});

test('节点超时后的五分钟内按两秒起点复检，不把请求耗时叠加进间隔', async t => {
  let sampling = false;
  const starts = [];
  const budgets = [];
  const exits = { a: 'SG' };
  const f = await fakeRuntime(t, undefined, { nodeExits: exits, observeExitProbe: options => {
    if (!sampling) return;
    starts.push(Date.now()); budgets.push(options.timeoutMs);
    t.mock.timers.tick(700);
  } });
  await f.runtime.importNodes([node('a')]);
  const launches = f.launches();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  sampling = true; exits.a = null; f.switchNetwork(); await f.tick();
  t.mock.timers.tick(1999); await f.tick();
  assert.equal(starts.length, 1, '首次进入网络锁后等待两秒');
  t.mock.timers.tick(1); await f.tick();
  assert.equal(starts.length, 2);
  assert.ok(budgets[1] < 2000, '恢复探测超时预算短于两秒，避免长请求堵住下一轮');
  t.mock.timers.tick(1299); await f.tick();
  assert.equal(starts.length, 2);
  exits.a = 'SG'; t.mock.timers.tick(1); await f.tick();
  assert.equal(starts[2] - starts[1], 2000, '两次请求起点间隔两秒，不额外累加700毫秒耗时');
  assert.equal(f.guard(), 'CLAUDE-PIN');
  assert.equal(f.launches(), launches);
});

test('隧道探测直接抛出超时也先进入恢复窗口，不立即重建健康内核', async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node('a')]);
  await f.runtime.setTunnel(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = f.launches();
  f.setTunnelActive(new Error('隧道解析探测超时。')); await f.tick();
  assert.equal(f.launches(), launches, '超时抛异常不能绕过五分钟恢复窗口');
  assert.equal(f.guard(), 'REJECT');
  assert.equal((await f.runtime.report()).regionLock.type, 'network');
  const switches = f.guardSwitches.length;
  f.switchNetwork();
  t.mock.timers.tick(2000); await f.tick();
  assert.ok(!f.guardSwitches.slice(switches).includes('CLAUDE-PIN'), '切网后隧道仍超时，即使出口探测成功也不能短暂放行');
  const beforeWake = f.guardSwitches.length;
  t.mock.timers.tick(16000); await f.tick();
  assert.ok(!f.guardSwitches.slice(beforeWake).includes('CLAUDE-PIN'), '唤醒后也必须重新确认隧道，不能先放行');
  f.setTunnelActive(true); t.mock.timers.tick(2000); await f.tick();
  assert.equal(f.guard(), 'CLAUDE-PIN');
  assert.equal(f.launches(), launches);
});

test('健康巡检不读取连接明细，采样接口超时不能导致内核重建', async t => {
  const dir = await directory(t);
  const requests = [];
  const core = createNetCore({ binary: process.execPath, homeDir: dir, configPath: path.join(dir, 'test.yaml'), manageProcess: false,
    fetchImpl: async url => {
      const route = new URL(url).pathname; requests.push(route);
      if (route === '/connections') throw new Error('signal timed out');
      return { ok: true, text: async () => JSON.stringify(route === '/version' ? { version: 'test' } : { proxies: {} }) };
    },
  });
  await core.start(); t.after(() => core.stop());
  requests.length = 0;
  assert.equal((await core.status({ includeConnections: false })).running, true);
  assert.deepEqual(requests.sort(), ['/proxies', '/version']);
  await assert.rejects(core.status(), /signal timed out/, '完整状态仍如实报告连接证据缺失');
});
