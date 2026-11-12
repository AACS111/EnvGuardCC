import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./claude-gateway.mjs";
import { publicIp, probe } from "./gateway-diagnostics.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const ui = { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui" };

test("real forwarding, profile reload, CORS, diagnostics isolation and secret redaction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-gateway-test-"));
  const profileFile = path.join(directory, "profile.json");
  let seen = null;
  let calls = 0;
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen = { headers: request.headers, body, url: request.url };
    response.writeHead(request.url.includes("denied") ? 401 : 200, { "Content-Type": "text/event-stream", "Connection": "keep-alive" });
    response.write("data: first\n\n");
    response.end("data: done\n\n");
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ upstreamBase: upstreamUrl, profileFile, collect: async () => { calls += 1; return { checkedAt: new Date().toISOString() }; } });
  const gatewayUrl = await listen(gateway);
  const get = (endpoint, headers = ui) => fetch(gatewayUrl + endpoint, { headers });
  const saveProfile = (language, updatedAt) => writeFile(profileFile, JSON.stringify({ target: {language, locale:language, timezone:"Asia/Seoul", authorization:"profile-secret"}, updatedAt }));
  try {
    assert.equal((await get("/__checkcc/status", {})).status, 403);
    assert.equal((await get("/__checkcc/status", {...ui, Origin:"https://evil.example"})).status, 403);
    const browserProbe = await get("/__checkcc/browser-probe", { ...ui, "Accept-Language": "ko-KR,ko;q=0.9", Authorization: "private-key", Cookie: "private-cookie" });
    assert.equal(browserProbe.status, 200);
    const browserSample = await browserProbe.json();
    assert.equal(browserSample.kind, "browser-headers-probe");
    assert.equal(browserSample.receivedLanguage, "ko-KR,ko;q=0.9");
    assert.doesNotMatch(JSON.stringify(browserSample), /private-key|private-cookie/);
    assert.equal((await get("/__checkcc/status").then(response=>response.json())).lastRequest, null);
    assert.equal((await fetch(gatewayUrl + "/__checkcc/browser-probe", { method: "POST", headers: ui })).status, 405);
    const reboundStatus = await new Promise((resolve, reject) => {
      http.get(gatewayUrl + "/__checkcc/status", {headers: {...ui, Host:"evil.example"}}, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    const cors = await fetch(gatewayUrl + "/__checkcc/diagnostics", {method:"OPTIONS",headers:{Origin:ui.Origin,"Access-Control-Request-Method":"GET"}});
    assert.equal(cors.status, 204);
    assert.equal(cors.headers.get("Access-Control-Allow-Origin"), ui.Origin);
    assert.equal(cors.headers.get("Access-Control-Allow-Private-Network"), "true");
    assert.equal((await fetch(gatewayUrl + "/__checkcc/status", {method:"POST",headers:ui})).status, 405);
    await saveProfile("ko-KR", "one");
    const before = await (await get("/__checkcc/status")).json();
    assert.equal(before.lastRequest, null, "A profile must not manufacture traffic evidence");
    assert.equal(before.previewHeaders["accept-language"], "ko-KR,ko;q=0.9,en;q=0.5");
    const result = await fetch(gatewayUrl + "/v1/messages?private=secret", {
      method:"POST",headers:{"content-type":"application/json", "x-api-key":"secret-key",authorization:"Bearer secret-auth", "accept-language":"zh-CN", "x-checkcc-client":"do-not-forward"},body:'{"messages":["private-prompt"]}',
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "data: first\n\ndata: done\n\n");
    assert.equal(seen.headers["x-api-key"], "secret-key");
    assert.equal(seen.headers.authorization, "Bearer secret-auth");
    assert.equal(seen.headers["accept-language"], before.previewHeaders["accept-language"]);
    assert.equal(seen.headers["x-checkcc-client"], undefined);
    assert.equal(seen.body, '{"messages":["private-prompt"]}');
    const after = await (await get("/__checkcc/diagnostics")).json();
    assert.equal(after.lastRequest.status, 200);
    assert.equal(after.lastRequest.profileUpdatedAt, "one");
    const serialized = JSON.stringify(after);
    for (const secret of ["secret-key", "secret-auth", "private-prompt", "private=secret", "profile-secret"]) assert.ok(!serialized.includes(secret), "Must not disclose " + secret);
    await Promise.all([get("/__checkcc/diagnostics"),get("/__checkcc/diagnostics")]);
    assert.equal(calls, 1, "Network probes should be cached");
    await saveProfile("en-GB", "two");
    const reloaded = await (await get("/__checkcc/status")).json();
    assert.equal(reloaded.previewHeaders["accept-language"], "en-GB,en;q=0.9");
    assert.equal(reloaded.lastRequest.profileUpdatedAt, "one", "Old traffic cannot verify a changed profile");
    const unrelated = await fetch(gatewayUrl + "/");
    await unrelated.text();
    assert.equal((await (await get("/__checkcc/status")).json()).lastRequest.profileUpdatedAt, "one", "A non-Claude request must not verify client integration");
    const denied = await fetch(gatewayUrl + "/v1/messages?denied=true", {method:"POST"});
    assert.equal(denied.status, 401);
    await denied.text();
    assert.equal((await (await get("/__checkcc/status")).json()).lastRequest.status, 401);
    await writeFile(profileFile, "invalid");
    assert.equal((await (await get("/__checkcc/status")).json()).profileError, "INVALID_PROFILE");
    assert.equal((await fetch(gatewayUrl + "/v1/messages")).status, 503);
  } finally { await close(gateway); await close(upstream); await rm(directory, {recursive:true,force:true}); }
});

test("probes distinguish HTTP authorization failures, malformed responses and timeouts", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/timeout") return;
    response.writeHead(request.url === "/auth" ? 401 : 200);
    response.end("invalid json");
  });
  const url = await listen(server);
  try {
    assert.equal((await probe(url + "/auth")).status, 401);
    assert.equal((await probe(url, {method:"GET",json:true})).error, "INVALID_JSON");
    assert.equal((await probe(url + "/timeout", {timeout:40})).status, null);
    for (const invalid of ["999.1.2.3", "127.0.0.1", "192.168.1.2", "100.64.1.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(publicIp(invalid), null);
    assert.equal(publicIp("8.8.8.8"), "8.8.8.8");
    assert.equal(publicIp("2606:4700:4700::1111"), "2606:4700:4700::1111");
  } finally { await close(server); }
});

test("optimization configures the gateway without the timezone helper and switches real forwarding", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-toggle-test-"));
  const profileFile = path.join(directory, "nested", "profile.json");
  let seen;
  const upstream = http.createServer((request, response) => {
    seen = request.headers;
    request.resume();
    response.end("ok");
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ upstreamBase: upstreamUrl, profileFile });
  const url = await listen(gateway);
  const toggle = (value) => fetch(url + "/__checkcc/cloak", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const status = async () => (await fetch(url + "/__checkcc/status", { headers: ui })).json();
  const forward = async () => { const result = await fetch(url + "/v1/messages", { method: "POST", headers: { "accept-language": "zh-CN", "x-checkcc-target-locale": "zh-CN" } }); await result.text(); assert.equal(result.status, 200); assert.deepEqual(Object.keys(seen).filter((key) => key.toLowerCase().startsWith("x-checkcc-")), [], "任何 x-checkcc-* 诊断头都不得发往真实上游"); };
  try {
    assert.equal((await status()).cloak.enabled, false, "No profile is not an active optimization");
    assert.equal((await toggle({ enabled: true })).status, 409);
    assert.equal((await toggle({ enabled: "yes" })).status, 400);
    assert.equal((await toggle({ enabled: true, target: { language: "bad\nvalue", locale: "ko-KR" } })).status, 400);
    const off = await toggle({ enabled: false });
    assert.equal((await off.json()).cloak.enabled, false, "Disabling must not require a profile or helper");
    const on = await toggle({ enabled: true, target: { language: "ko-KR", locale: "ko-KR", timezone: "Asia/Seoul", authorization: "do-not-store" } });
    assert.equal(on.status, 200);
    const saved = await on.json();
    assert.equal(saved.cloak.enabled, true);
    assert.equal(saved.cloak.target.language, "ko-KR");
    assert.equal(saved.cloak.target.authorization, undefined);
    await forward();
    assert.equal(seen["accept-language"], "ko-KR,ko;q=0.9,en;q=0.5");
    assert.equal(seen["x-checkcc-target-locale"], undefined, "区域标记必须留在本地");
    assert.equal((await toggle({ enabled: true, target: { language: "invalid", locale: "ko-KR" } })).status, 400);
    assert.equal((await status()).cloak.enabled, true, "A rejected request must preserve the confirmed state");
    assert.equal((await toggle({ enabled: false })).status, 200);
    assert.equal((await status()).cloak.enabled, false, "Reload reads the actual disabled state");
    await forward();
    assert.equal(seen["accept-language"], "zh-CN");
    assert.equal(seen["x-checkcc-target-locale"], undefined, "关闭改写时同样不得上行");
    assert.equal((await toggle({ enabled: true })).status, 200, "Saved target may be reused");
    await writeFile(profileFile, "broken");
    assert.equal((await toggle({ enabled: false })).status, 200, "A damaged profile must not block disabling");
  } finally {
    await toggle({ enabled: true, target: { language: "en-US", locale: "en-US" } });
    await close(gateway); await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics 暴露内核状态，未接入时明确显示未启用", async () => {
  const withKernel = createGateway({ netCore: { report: async () => ({ state: "running", version: "fake-1.0", routing: { state: "unknown" } }) }, collect: async () => ({}) });
  const url = await listen(withKernel);
  try {
    const report = await (await fetch(url + "/__checkcc/diagnostics", { headers: ui })).json();
    assert.equal(report.netCore.state, "running");
    assert.equal(report.netCore.version, "fake-1.0");
    // 内核状态不得出现在 status 接口，避免与配置混淆。
    const status = await (await fetch(url + "/__checkcc/status", { headers: ui })).json();
    assert.equal(status.netCore, undefined);
  } finally {
    await close(withKernel);
  }

  const withoutKernel = createGateway({ collect: async () => ({}) });
  const url2 = await listen(withoutKernel);
  try {
    const report = await (await fetch(url2 + "/__checkcc/diagnostics", { headers: ui })).json();
    assert.equal(report.netCore.state, "disabled");
    assert.match(report.netCore.reason, /未接入网络内核/);
  } finally {
    await close(withoutKernel);
  }

  const failing = createGateway({ netCore: { report: async () => { throw new Error("内核不可用"); } }, collect: async () => ({}) });
  const url3 = await listen(failing);
  try {
    const report = await (await fetch(url3 + "/__checkcc/diagnostics", { headers: ui })).json();
    assert.equal(report.netCore.state, "unavailable");
    assert.match(report.netCore.reason, /内核不可用/);
  } finally {
    await close(failing);
  }
});

test("内核导入接口：支持链接/内容/手工，非法输入明确拒绝", async () => {
  const captured = [];
  const netCore = {
    report: async () => ({ state: "idle", nodes: [] }),
    importNodes: async (proxies, options) => {
      captured.push({ proxies, options });
      return { imported: proxies.length, skipped: [], selected: proxies[0]?.name ?? null };
    },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = (body) => fetch(url + "/__checkcc/net-core/import", {
    method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const clash = "proxies:\n  - name: n1\n    type: ss\n    server: a.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: p\n";
    const content = await post({ mode: "content", content: clash });
    assert.equal(content.status, 200);
    const contentBody = await content.json();
    assert.equal(contentBody.ok, true);
    assert.equal(contentBody.imported, 1);
    assert.equal(captured.at(-1).proxies[0].name, "n1");
    assert.equal(contentBody.netCore.state, "idle");

    const manual = await (await post({ mode: "manual", proxies: [{ name: "m1", type: "ss", server: "b.example.com", port: 8080, cipher: "aes-128-gcm", password: "p" }] })).json();
    assert.equal(manual.ok, true);
    assert.equal(captured.at(-1).proxies[0].name, "m1");

    assert.equal((await post({ mode: "content", content: "hello world" })).status, 400);
    assert.equal((await post({ mode: "ftp" })).status, 400);
    assert.equal((await fetch(url + "/__checkcc/net-core/import", { headers: ui })).status, 405);

    const noRuntime = createGateway({ collect: async () => ({}) });
    const url2 = await listen(noRuntime);
    try {
      const response = await fetch(url2 + "/__checkcc/net-core/import", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "content", content: clash }) });
      const value = await response.json();
      assert.equal(value.ok, false);
      assert.match(value.reason, /未接入网络内核/);
    } finally { await close(noRuntime); }
  } finally {
    await close(gateway);
  }
});

test("配置来源接口：列出、切换、重命名、删除、刷新，非法操作明确拒绝", async () => {
  const calls = [];
  const netCore = {
    report: async () => ({ state: "running" }),
    sources: () => [{ id: "src_a", name: "A 机场", mode: "url", nodeCount: 1, active: true }],
    activateSource: async (id) => { calls.push(["activate", id]); return { activeId: id, changed: true }; },
    deleteSource: async (id) => { calls.push(["delete", id]); return { activeId: null }; },
    renameSource: async (id, name) => { calls.push(["rename", id, name]); return { id, name }; },
    refresh: async (options) => { calls.push(["refresh", options]); return { imported: 2 }; },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = (body) => fetch(url + "/__checkcc/net-core/sources", {
    method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const listed = await (await fetch(url + "/__checkcc/net-core/sources", { headers: ui })).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.sources[0].name, "A 机场");

    assert.equal((await (await post({ action: "activate", id: "src_a" })).json()).activeId, "src_a");
    assert.equal((await (await post({ action: "rename", id: "src_a", name: "A 二号" })).json()).name, "A 二号");
    const refreshed = await (await post({ action: "refresh", id: "src_a" })).json();
    assert.equal(refreshed.imported, 2);
    assert.deepEqual(calls[2], ["refresh", { force: true, sourceId: "src_a" }]);
    assert.equal((await (await post({ action: "delete", id: "src_a" })).json()).activeId, null);

    assert.equal((await post({ action: "explode", id: "src_a" })).status, 400);
    assert.equal((await post({ action: "activate" })).status, 400);
    assert.equal((await fetch(url + "/__checkcc/net-core/sources", { method: "PUT", headers: ui })).status, 405);

    const failing = createGateway({ netCore: { ...netCore, activateSource: async () => { throw new Error("该配置没有可用节点"); } }, collect: async () => ({}) });
    const url2 = await listen(failing);
    try {
      const bad = await (await fetch(url2 + "/__checkcc/net-core/sources", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ action: "activate", id: "src_a" }) })).json();
      assert.equal(bad.ok, false);
      assert.match(bad.reason, /没有可用节点/);
    } finally { await close(failing); }

    const noRuntime = createGateway({ collect: async () => ({}) });
    const url3 = await listen(noRuntime);
    try {
      const empty = await (await fetch(url3 + "/__checkcc/net-core/sources", { headers: ui })).json();
      assert.equal(empty.ok, false);
      assert.match(empty.reason, /未接入网络内核/);
    } finally { await close(noRuntime); }
  } finally { await close(gateway); }
});

test('开启防火墙接口必须有明确确认，普通启动和重启不走自动开启', async () => {
  let enabled = 0, restarted = 0;
  const gateway = createGateway({ netCore: {
    report: async () => ({ state: 'running' }),
    enableFirewall: async options => { assert.deepEqual(options, { confirmed: true }); enabled++; },
    restart: async () => { restarted++; return true; },
    stop: async () => assert.fail('重启必须使用保留阻断的专用入口'),
  }, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = body => fetch(url + '/__checkcc/net-core', { method: 'POST', headers: { ...ui, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ action: 'enable-firewall' })).status, 400);
    assert.equal((await post({ action: 'enable-firewall', confirmed: false })).status, 400);
    assert.equal(enabled, 0);
    assert.equal((await (await post({ action: 'enable-firewall', confirmed: true })).json()).ok, true);
    assert.equal(enabled, 1);
    assert.equal((await (await post({ action: 'restart' })).json()).ok, true);
    assert.equal(restarted, 1);
    assert.equal(enabled, 1);
  } finally { await close(gateway); }
});

test("内核动作失败时把报告里的真实原因带回接口", async () => {
  const netCore = {
    report: async () => ({ state: "error", reason: "TUN 需要更高权限：安装特权助手后重试。" }),
    start: async () => false,
    stop: async () => {},
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  try {
    const response = await fetch(url + "/__checkcc/net-core", {
      method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }),
    });
    const value = await response.json();
    assert.equal(value.ok, false);
    // start() 用返回值表达失败：不能只回一个没有信息量的 ok:false。
    assert.match(value.reason, /TUN 需要更高权限/);
    assert.equal(value.netCore.state, "error");
  } finally { await close(gateway); }
});

test("特权宿主安装接口：只接受 install，失败原因原样返回", async () => {
  const netCore = {
    report: async () => ({ state: "running", hostMode: false }),
    installHost: async () => ({ installed: true, hostMode: true }),
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = (body) => fetch(url + "/__checkcc/net-core/host", {
    method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(url + "/__checkcc/net-core/host", { headers: ui })).status, 405);
    assert.equal((await post({ action: "uninstall" })).status, 400);
    const installed = await (await post({ action: "install" })).json();
    assert.equal(installed.ok, true);
    assert.equal(installed.hostMode, true);

    const failing = { report: async () => ({ state: "error" }), installHost: async () => { throw new Error("授权已取消，未安装特权宿主。"); } };
    const g2 = createGateway({ netCore: failing, collect: async () => ({}) });
    const url2 = await listen(g2);
    try {
      const refused = await (await fetch(url2 + "/__checkcc/net-core/host", {
        method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ action: "install" }),
      })).json();
      assert.equal(refused.ok, false);
      assert.match(refused.reason, /授权已取消/);
    } finally { await close(g2); }

    const noRuntime = createGateway({ collect: async () => ({}) });
    const url3 = await listen(noRuntime);
    try {
      const value = await (await fetch(url3 + "/__checkcc/net-core/host", {
        method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ action: "install" }),
      })).json();
      assert.equal(value.ok, false);
      assert.match(value.reason, /未接入网络内核/);
    } finally { await close(noRuntime); }
  } finally { await close(gateway); }
});

test("内核订阅刷新接口：到期跳过与强制刷新都能如实返回", async () => {
  const calls = [];
  const netCore = {
    report: async () => ({ state: "running", nodes: ["n1"] }),
    refresh: async (options) => { calls.push(options); return { skipped: false, imported: 1, selected: "n1" }; },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  try {
    const response = await fetch(url + "/__checkcc/net-core/refresh", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.equal(value.imported, 1);
    assert.deepEqual(calls.at(-1), { force: true });
    assert.equal((await fetch(url + "/__checkcc/net-core/refresh", { headers: ui })).status, 405);

    const failing = { report: async () => ({ state: "disabled" }), refresh: async () => { throw new Error("当前节点不是从订阅链接导入的，无法自动更新。"); } };
    const g2 = createGateway({ netCore: failing, collect: async () => ({}) });
    const url2 = await listen(g2);
    try {
      const bad = await fetch(url2 + "/__checkcc/net-core/refresh", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(bad.status, 400);
      const body = await bad.json();
      assert.equal(body.ok, false);
      assert.match(body.reason, /不是从订阅链接导入/);
    } finally { await close(g2); }
  } finally {
    await close(gateway);
  }
});

test("诊断接口附带出口历史，且不因历史文件缺失而失败", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-exithist-"));
  const gateway = createGateway({ collect: async () => ({ exit: { primary: { ip: "8.8.8.8" }, sources: [] } }), stateDir: directory });
  const url = await listen(gateway);
  try {
    for (const expected of [0, 0]) {
      const report = await (await fetch(url + "/__checkcc/diagnostics", { headers: ui })).json();
      assert.equal(report.exitHistory.samples, 1, "同一 IP 只记录一次");
      assert.equal(report.exitHistory.changes, expected);
    }
    const stored = JSON.parse(await readFile(path.join(directory, "exit-history.json"), "utf8"));
    assert.equal(stored.entries[0].ip, "8.8.8.8");
  } finally {
    await close(gateway);
    await rm(directory, { recursive: true, force: true });
  }
});

test("节点测速接口：逐个返回延迟，失败节点为 null", async () => {
  const netCore = {
    report: async () => ({ state: "running" }),
    delay: async (name) => (name === "慢节点" ? null : 88),
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  try {
    const response = await fetch(url + "/__checkcc/net-core/delay", {
      method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ names: ["好节点", "慢节点"] }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.deepEqual(value.delays, { 好节点: 88, 慢节点: null });
    assert.equal((await fetch(url + "/__checkcc/net-core/delay", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ names: [] }) })).status, 400);
  } finally {
    await close(gateway);
  }
});

test("出站模式接口：切换成功后返回最新状态，非法模式被拒绝", async () => {
  const seen = [];
  const netCore = {
    report: async () => ({ state: "running", mode: "rule" }),
    setMode: async (mode) => { if (mode === "turbo") throw new Error("未知出站模式：turbo"); seen.push(mode); return { mode }; },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  try {
    const ok = await fetch(url + "/__checkcc/net-core/mode", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "global" }) });
    assert.equal(ok.status, 200);
    const value = await ok.json();
    assert.equal(value.ok, true);
    assert.equal(value.mode, "global");
    assert.deepEqual(seen, ["global"]);

    const bad = await fetch(url + "/__checkcc/net-core/mode", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "turbo" }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).reason, /未知出站模式/);
    assert.equal((await fetch(url + "/__checkcc/net-core/mode", { headers: ui })).status, 405);
  } finally {
    await close(gateway);
  }
});

test("网络声明接口：GET 返回真实产物，POST 按后端校验拒绝，其它方法 405", async () => {
  const calls = [];
  const state = {
    path: "/state/net-core-network.json",
    config: { directDomains: ["corp.example"] },
    effective: { target: "DIRECT", domainRules: ["DOMAIN-SUFFIX,corp.example,DIRECT"], ipRules: [], nameserverPolicy: {}, fakeIpFilter: [], dnsServers: ["system"], defaultExclusions: ["192.168.0.0/16"], redundantAddresses: [] },
    problem: null, interfaces: [{ name: "test-ethernet", address: "192.0.2.10" }], pendingRestart: false, canRestart: true,
  };
  const netCore = {
    report: async () => ({ state: "idle" }),
    network: async () => state,
    saveNetwork: async (config, options) => {
      calls.push({ config, options });
      if (config.strictRoute === "false") throw new Error("strictRoute 必须是布尔值。");
      return { ...state, config, pendingRestart: !options.restart };
    },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = (body) => fetch(url + "/__checkcc/net-core/network", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const read = await (await fetch(url + "/__checkcc/net-core/network", { headers: ui })).json();
    assert.equal(read.ok, true);
    assert.deepEqual(read.interfaces[0], { name: "test-ethernet", address: "192.0.2.10" });
    assert.equal(read.effective.target, "DIRECT");

    const saved = await (await post({ config: { directDomains: ["corp.example"] }, restart: true })).json();
    assert.equal(saved.ok, true);
    assert.deepEqual(calls.at(-1), { config: { directDomains: ["corp.example"] }, options: { restart: true } });
    assert.equal(saved.pendingRestart, false);

    const savedNoRestart = await (await post({ config: { directDomains: ["corp.example"] } })).json();
    assert.equal(savedNoRestart.pendingRestart, true);

    const rejected = await post({ config: { strictRoute: "false" } });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).reason, /strictRoute/);

    assert.equal((await post({})).status, 400);
    assert.equal((await fetch(url + "/__checkcc/net-core/network", { method: "PUT", headers: ui })).status, 405);
  } finally { await close(gateway); }
});

test("解析测试接口：返回内核真实解析结果，错误原样透出，非 POST 405", async () => {
  const calls = [];
  const netCore = {
    report: async () => ({ state: "idle" }),
    network: async () => ({ path: "/state/net-core-network.json", config: {}, effective: null, problem: null, interfaces: [], pendingRestart: false, canRestart: true }),
    verifyDomain: async (config, name) => {
      calls.push({ config, name });
      if (name === "bad") throw new Error("请填写有效的域名（不含 http:// 或端口）。");
      return { name, status: 0, addresses: ["192.0.2.20"], fakeIp: false, restarted: true, elapsedMs: 12 };
    },
  };
  const gateway = createGateway({ netCore, collect: async () => ({}) });
  const url = await listen(gateway);
  const post = (body) => fetch(url + "/__checkcc/net-core/verify-domain", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ok = await (await post({ config: { directDomains: ["corp.example"] }, name: "api.corp.example" })).json();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.addresses, ["192.0.2.20"]);
    assert.equal(ok.restarted, true);
    assert.deepEqual(calls.at(-1), { config: { directDomains: ["corp.example"] }, name: "api.corp.example" });

    const bad = await post({ config: { directDomains: ["corp.example"] }, name: "bad" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).reason, /有效的域名/);

    assert.equal((await fetch(url + "/__checkcc/net-core/verify-domain", { headers: ui })).status, 405);
    assert.equal((await post({ name: "x.example" })).status, 400);
  } finally { await close(gateway); }
});

test("声明面：UA 与 Client Hints 只归一化矛盾，不伪造平台也不凭空补头", async () => {
  const { buildHeaders, alignClientHints, headerConsistency } = await import("./claude-gateway.mjs");
  const profile = { language: "ko-KR", locale: "ko-KR", timezone: "Asia/Seoul", updatedAt: "now" };
  const winUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  // 平台与主版本都被纠正；Not?A_Brand 的版本保持不变。
  const drifted = buildHeaders({
    "user-agent": winUa,
    "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not?A_Brand";v="24"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-mobile": "?1",
    "accept-language": "zh-CN,zh;q=0.9",
  }, profile, true);
  assert.equal(drifted["accept-language"], "ko-KR,ko;q=0.9,en;q=0.5");
  assert.equal(drifted["sec-ch-ua"], '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="24"');
  assert.equal(drifted["sec-ch-ua-platform"], '"Windows"');
  assert.equal(drifted["sec-ch-ua-mobile"], "?0");
  assert.deepEqual(headerConsistency(drifted), { platform: "Windows", hintPlatform: "Windows", major: "141", hintMajor: "141", aligned: true });

  // Android 客户端：移动标记必须为 ?1。
  const android = alignClientHints({ "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/141.0.0.0 Mobile", "sec-ch-ua": '"Chromium";v="141"', "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-mobile": "?0" });
  assert.equal(android["sec-ch-ua-platform"], '"Android"');
  assert.equal(android["sec-ch-ua-mobile"], "?1");

  // 客户端没发 UA-CH 时不凭空造头（凭空出现的 hints 本身就是指纹）。
  const noHints = alignClientHints({ "user-agent": winUa });
  assert.equal(noHints["sec-ch-ua"], undefined);
  assert.equal(noHints["sec-ch-ua-platform"], undefined);

  // 关闭模拟保护时原样转发，不做任何归一化。
  const off = buildHeaders({ "user-agent": winUa, "sec-ch-ua": '"Chromium";v="140"', "sec-ch-ua-platform": '"macOS"', "accept-language": "zh-CN" }, profile, false);
  assert.equal(off["accept-language"], "zh-CN");
  assert.equal(off["sec-ch-ua-platform"], '"macOS"');
  assert.equal(off["sec-ch-ua"], '"Chromium";v="140"');

  // 诊断事实：UA 与 hints 矛盾时必须报 aligned=false。
  assert.equal(headerConsistency({ "user-agent": winUa, "sec-ch-ua-platform": '"macOS"' }).aligned, false);
});

test('传输记录接口只允许本机 UI，支持分页/筛选与显式清空，未启动内核返回空记录', async () => {
  const { createConnectionLog } = await import('./net-core/connection-log.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'checkcc-connection-api-'));
  const log = await createConnectionLog({ stateDir: directory });
  await log.sample([
    { id: 'claude', metadata: { host: 'api.anthropic.com', destinationIP: '203.0.113.1', destinationPort: 443, processPath: 'SECRET_PATH' }, chains: ['node', 'CLAUDE-PIN'], upload: 123, download: 456 },
    { id: 'domestic', metadata: { host: 'www.baidu.com' }, chains: ['node', 'AUTO-PROXY'] },
    { id: 'direct', metadata: { host: 'local.example' }, chains: ['DIRECT'] },
    { id: 'blocked', metadata: { host: 'blocked.example' }, chains: ['REJECT'] },
  ]);
  const server = createGateway({ netCore: { connectionLog: log }, collect: async () => ({}) });
  const url = await listen(server);
  const route = url + '/__checkcc/net-core/connections';
  try {
    assert.equal((await fetch(route)).status, 403);
    assert.equal((await fetch(route, { headers: { ...ui, Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(route, { method: 'DELETE', headers: ui })).status, 405);
    for (const query of ['?viaExit=maybe', '?offset=-1', '?limit=bad', '?claude=maybe']) assert.equal((await fetch(route + query, { headers: ui })).status, 400);
    const filtered = await (await fetch(route + '?claude=true&viaExit=true&host=anthropic&limit=1', { headers: ui })).json();
    assert.equal(filtered.total, 1); assert.equal(filtered.stats.total, 4);
    assert.equal(filtered.items[0].download, 456);
    assert.doesNotMatch(JSON.stringify(filtered), /SECRET_PATH|processPath/);
    for (const value of ['proxied','direct','blocked']) {
      const collection = await (await fetch(route + '?route=' + value + '&state=active&kind=connection', { headers: ui })).json();
      assert.ok(collection.items.length > 0);
      assert.ok(collection.items.every(record => record.route === value && !record.endedAt));
    }
    for (const query of ['?route=invalid','?state=invalid']) assert.equal((await fetch(route + query,{headers:ui})).status,400);
    const page = await (await fetch(route + '?limit=1&offset=1', { headers: ui })).json();
    assert.equal(page.items.length, 1); assert.equal(page.offset, 1);
    const invalid = await fetch(route, { method: 'POST', headers: ui, body: '{}' });
    assert.equal(invalid.status, 400);
    assert.equal((await log.list()).total, 4);
    await log.stop();
    const result = await (await fetch(route, { method: 'POST', headers: { ...ui, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear' }) })).json();
    assert.equal(result.cleared, true); assert.equal(result.total, 0);
    await assert.rejects(readFile(path.join(directory, 'net-core-connections.json')), { code: 'ENOENT' });
  } finally { await log.stop(); await close(server); await rm(directory, { recursive: true, force: true }); }
  const emptyServer = createGateway({ collect: async () => ({}) });
  const emptyUrl = await listen(emptyServer);
  try {
    const empty = await (await fetch(emptyUrl + '/__checkcc/net-core/connections', { headers: ui })).json();
    assert.equal(empty.ok, true); assert.equal(empty.available, false); assert.deepEqual(empty.items, []);
  } finally { await close(emptyServer); }
});

test('真实 HTTP 网关保存请求状态/耗时与计数字节，导出与回放不泄露 query/正文，记录范围可保存', async () => {
  const { createConnectionLog } = await import('./net-core/connection-log.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'checkcc-request-log-'));
  const log = await createConnectionLog({ stateDir: directory });
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{"result":"SECRET_RESPONSE"}'); });
  });
  const base = await listen(upstream);
  const server = createGateway({ upstreamBase: base, profileFile: path.join(directory, 'missing-profile.json'), netCore: { connectionLog: log }, collect: async () => ({}) });
  const url = await listen(server);
  const route = url + '/__checkcc/net-core/connections';
  try {
    const forwarded = await fetch(url + '/v1/messages?token=SECRET_QUERY', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer SECRET_AUTH' }, body: '{"message":"SECRET_BODY"}' });
    assert.equal(forwarded.status, 201); await forwarded.text();
    const listed = await (await fetch(route + '?kind=request', { headers: ui })).json();
    assert.equal(listed.total, 1);
    const record = listed.items[0];
    assert.equal(record.method, 'POST'); assert.equal(record.endpoint, '/v1/messages'); assert.equal(record.status, 201);
    assert.ok(record.endedAt); assert.ok(record.elapsedMs >= 0); assert.ok(record.upload > 0); assert.ok(record.download > 0);
    assert.equal(record.viaExit, null, '请求层不能冒充已验证内核代理链');
    assert.doesNotMatch(JSON.stringify(listed), /SECRET_|Authorization|authorization/);
    const detail = await (await fetch(route + '?host=absent&detailId=' + record.id, { headers: ui })).json();
    assert.equal(detail.total, 0); assert.equal(detail.selected.id, record.id);
    const replay = await (await fetch(route + '?at=' + encodeURIComponent(record.startedAt), { headers: ui })).json();
    assert.equal(replay.total, 1);
    const exported = await fetch(route + '?format=csv&limit=1&kind=request', { headers: ui });
    assert.match(exported.headers.get('content-type'), /text\/csv/);
    assert.match(exported.headers.get('content-disposition'), /attachment/);
    const csv = await exported.text(); assert.match(csv, /\/v1\/messages/); assert.doesNotMatch(csv, /SECRET_/);
    const json = await (await fetch(route + '?format=json', { headers: ui })).json();
    assert.equal(json.records.length, 1); assert.doesNotMatch(JSON.stringify(json), /SECRET_/);
    const settings = await (await fetch(route, { method: 'POST', headers: { ...ui, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', scope: 'claude' }) })).json();
    assert.equal(settings.scope, 'claude');
    assert.equal((await (await fetch(route + '?view=settings', { headers: ui })).json()).scope, 'claude');
    for (const query of ['?kind=bad', '?format=html', '?at=bad', '?detailId=../private']) assert.equal((await fetch(route + query, { headers: ui })).status, 400);
    assert.equal((await fetch(route, { method: 'POST', headers: ui, body: '{"action":"settings","scope":"invalid"}' })).status, 400);
  } finally { await close(server); await close(upstream); await log.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('上游连接失败和客户端中断也会结束请求记录，错误不含敏感 URL', async () => {
  const { createConnectionLog } = await import('./net-core/connection-log.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'checkcc-aborted-log-'));
  const log = await createConnectionLog({ stateDir: directory });
  const probeServer = http.createServer(); const closedBase = await listen(probeServer); await close(probeServer);
  const server = createGateway({ upstreamBase: closedBase, profileFile: path.join(directory, 'missing.json'), netCore: { connectionLog: log } });
  const url = await listen(server);
  try {
    const response = await fetch(url + '/v1/messages?token=SECRET', { method: 'POST', body: 'SECRET_BODY' });
    assert.equal(response.status, 502); await response.text();
    const record = (await log.list({ kind: 'request' })).items[0];
    assert.equal(record.error, 'UPSTREAM_ERROR'); assert.equal(record.status, null); assert.ok(record.endedAt);
    assert.doesNotMatch(await log.export(), /SECRET/);
  } finally { await close(server); }
  const streaming = http.createServer((request, response) => { request.resume(); response.writeHead(200); response.write('streaming'); });
  const upstream = await listen(streaming);
  const next = createGateway({ upstreamBase: upstream, profileFile: path.join(directory, 'missing.json'), netCore: { connectionLog: log } });
  const nextUrl = await listen(next);
  try {
    const controller = new AbortController();
    const response = await fetch(nextUrl + '/v1/messages', { method: 'POST', body: '{}', signal: controller.signal });
    await response.body.getReader().read(); controller.abort();
    let record;
    for (let i = 0; i < 30; i++) {
      record = (await log.list({ kind: 'request' })).items.find(item => item.status === 200);
      if (record?.endedAt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(record.error, 'CLIENT_ABORTED'); assert.ok(record.endedAt);
  } finally { await close(next); await close(streaming); await log.stop(); await rm(directory, { recursive: true, force: true }); }
});
