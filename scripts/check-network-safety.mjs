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
import { buildHostInstallPlan } from "./net-core/service.mjs";
import { stageHostBundle } from "./net-core/host-bundle.mjs";
import { createNetCore } from "./net-core.mjs";
import { ProtectionSession } from "./protection-session.mjs";

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

async function fakeRuntime(t, takeover = { prepare: async () => {}, status: () => ({ phase: "idle", closed: [] }) }, { host = false } = {}) {
  const dir = await directory(t);
  let failNext = false;
  let failedReloads = 0;
  let tunnelActive = true;
  const hostActions = [];
  let capturedSecret;
  let starts = 0, maxStarts = 0;
  let healthBroken = false, scheduled = null, interfaceAddress = "192.0.2.10", launches = 0;
  const runtime = await createKernelRuntime({
    stateDir: dir,
    takeover,
    env: { CHECKCC_NET_CORE_BINARY: process.execPath, CHECKCC_NET_CORE_TUN: "0", CHECKCC_NET_CORE_DNS: "https://192.0.2.53/dns-query",
      ...(host ? { CHECKCC_NET_CORE_HOST: "http://127.0.0.1:39091", CHECKCC_NET_CORE_HOST_TOKEN: "test-host-token" } : {}),
    },
    fetchImpl: async (_url, options) => {
      hostActions.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
    interfaces: () => ({ test: [{ address: interfaceAddress, internal: false }] }),
    healthScheduler: { every: callback => { scheduled = callback; return { unref() {} }; }, clear: () => { scheduled = null; } },
    createCore: options => {
      // 能力探测不访问真实节点，也不操作系统 IPv6。
      if (options.configPath.endsWith("probe.yaml")) return { start: async () => { throw new Error("test probe disabled"); }, stop: async () => {} };
      capturedSecret = options.secret;
      let running = false, config;
      return {
        start: async () => {
          starts++; maxStarts = Math.max(maxStarts, starts);
          try {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (failNext) { failNext = false; throw new Error("injected launch failure"); }
            config = yaml(await readFile(options.configPath, "utf8"));
            running = true;
            healthBroken = false;
            launches++;
          } finally { starts--; }
        },
        stop: async () => { running = false; },
        state: () => ({ running }),
        status: async () => {
          if (!running || healthBroken) throw new Error("not running");
          return { version: "test", connections: [], proxies: { proxies: { "CLAUDE-PIN": { now: config["proxy-groups"][0].proxies[0] } } } };
        },
        request: async () => ({ delay: 1 }),
        tunnelStatus: async () => ({ active: tunnelActive }),
        reloadFromFile: async () => {
          config = yaml(await readFile(options.configPath, "utf8"));
          if (failedReloads > 0) { failedReloads--; throw new Error("injected reload failure"); }
        },
      };
    },
  });
  t.after(() => runtime.stop());
  return { runtime, dir, fail: () => { failNext = true; }, secret: () => capturedSecret, maximum: () => maxStarts,
    failReload: (count = 1) => { failedReloads = count; }, hostActions,
    setTunnelActive: value => { tunnelActive = value; },
    tick: async () => { await scheduled?.(); }, disconnect: () => { healthBroken = true; },
    switchNetwork: () => { interfaceAddress = "192.0.2.11"; }, launches: () => launches,
  };
}

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

test("未保护阻断保持系统接管并拒绝 Claude 域名", async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node("a")]);
  const before = await f.runtime.report();
  assert.equal(before.tunEnabled, false);

  await f.runtime.setUnprotectedGuard(true);
  const blocked = await f.runtime.report();
  assert.equal(blocked.unprotectedGuard?.active, true);
  assert.equal(blocked.claudeBlocked, true);
  assert.equal(blocked.tunEnabled, true, "阻断必须建立在真实的系统接管上");
  const config = yaml(await readFile(path.join(f.dir, "net-core/config.yaml"), "utf8"));
  for (const domain of ["anthropic.com", "claude.ai", "claude.com", "claudeusercontent.com"]) {
    assert.ok(config.rules.includes(`DOMAIN-SUFFIX,${domain},REJECT`), `${domain} 必须被拒绝`);
  }
  await assert.rejects(f.runtime.setTunnel(false), /保护未开启/);

  await f.runtime.setUnprotectedGuard(false);
  const cleared = await f.runtime.report();
  assert.equal(cleared.unprotectedGuard, null);
  // 出口探测在测试环境不可达时可能已有区域锁；未保护阻断不得在解除后残留。
  assert.equal(cleared.claudeBlocked, Boolean(before.regionLock?.locked));
  assert.equal(cleared.tunEnabled, true, "解除阻断不主动关闭保护即将使用的 TUN");
});

test("未保护阻断失败时回滚接管且不声明 Claude 已被阻断", async t => {
  const f = await fakeRuntime(t, undefined, { host: true });
  await f.runtime.importNodes([node("a")]);
  f.setTunnelActive(false);
  await assert.rejects(f.runtime.setUnprotectedGuard(true), /接管/);
  const report = await f.runtime.report();
  assert.equal(report.unprotectedGuard, null);
  assert.equal(report.tunEnabled, false, "建立失败不能留下半开的接管");
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
