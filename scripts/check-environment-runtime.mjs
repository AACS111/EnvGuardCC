import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EnvironmentRuntime, validatePolicy, browserNetworkArgs } from "./environment-runtime.mjs";
import { runtimePolicyScript, restoreRuntimePolicy, verifyRuntimePolicy, migrateRuntimePolicy } from "../src/detection/runtime-policy.mjs";
import { BrowserCloakController } from "./browser-cloak.mjs";
import { createGateway, cloakState, setCloak } from "./claude-gateway.mjs";

test("执行器拒绝任意脚本、无效语言和不可直接修改的网络配置", () => {
  for (const input of [{ script: "process.exit()" }, { country: "KR" }, { fontMode: "invent-fonts" }, { languages: ["en-US;bad"] }, { vendorFontLimit: -1 }, []]) assert.throws(() => validatePolicy(input));
  assert.deepEqual(validatePolicy({ fontMode: "none", languages: ["en-US", "ko-KR"], locale: "en-US", webrtcDisabled: true }), { fontMode: "none", languages: ["en-US", "ko-KR"], locale: "en-US", webrtcDisabled: true });
});

test("历史禁用配置迁移为可采样的中继保护且保留其他配置", async () => {
  const legacy = {webrtcDisabled:true,languages:["ko-KR"],locale:"ko-KR",fontMode:"none"};
  assert.deepEqual(migrateRuntimePolicy(legacy),{...legacy,webrtcDisabled:false,webrtcRelayOnly:true});
  assert.equal(legacy.webrtcDisabled,true);
  const directory = await mkdtemp(path.join(tmpdir(),"checkcc-policy-migration-"));
  try {
    await writeFile(path.join(directory,"environment-policy.json"),JSON.stringify(legacy));
    const runtime = new EnvironmentRuntime({stateDir:directory,networkProxy:null});
    await runtime.load();
    assert.equal(runtime.policy.webrtcDisabled,false);
    assert.equal(runtime.policy.webrtcRelayOnly,true);
    assert.deepEqual(runtime.policy.languages,["ko-KR"]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("隔离浏览器复用真实代理、阻止本地 DNS 回退且不泄露认证信息", () => {
  assert.deepEqual(browserNetworkArgs(null), []);
  const args = browserNetworkArgs({url:new URL("http://127.0.0.1:7890")});
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:7890"));
  assert.ok(args.includes("--disable-quic"));
  assert.ok(args.some(arg => arg.includes("MAP * ~NOTFOUND")));
  assert.throws(() => browserNetworkArgs({url:new URL("http://user:secret@localhost:7890")}), /带认证/);
});

test("实际 Chromium 将未知目标域名交给代理，不依赖本地 DNS", {timeout:15000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(),"checkcc-proxy-browser-"));
  const requests = [];
  const proxy = http.createServer((request,response) => {
    requests.push(request.url);
    response.writeHead(200,{"Content-Type":"text/html"});
    response.end("<html><body>proxy-route-confirmed</body></html>");
  });
  await new Promise(resolve => proxy.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const runtime = new EnvironmentRuntime({stateDir:directory,headless:true,networkProxy:{url:new URL(origin)}});
  try {
    const instance = await runtime.launch("web",origin);
    const [sessionId] = [...instance.sessions].find(([,item]) => item.type === "page");
    const navigation = await instance.client.send("Page.navigate",{url:"http://checkcc-proxy-test.invalid/"},sessionId);
    assert.equal(navigation.errorText,undefined);
    assert.ok(requests.includes("http://checkcc-proxy-test.invalid/"));
  } finally {
    await runtime.close();
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test("WebRTC 中继限制保留原生接口、阻止重新配置绕过并可撤销", () => {
  class RTC {
    constructor(config) { this.config = config ?? {iceTransportPolicy:"all"}; }
    setConfiguration(config) { this.config = config; }
    getConfiguration() { return this.config; }
    close() {}
  }
  const context = vm.createContext({RTCPeerConnection:RTC});
  const result = vm.runInContext(runtimePolicyScript({webrtcRelayOnly:true,webrtcDisabled:false}), context);
  assert.equal(verifyRuntimePolicy({webrtcRelayOnly:true,webrtcDisabled:false}, result), true);
  const connection = new context.RTCPeerConnection({iceTransportPolicy:"all"});
  assert.ok(connection instanceof RTC);
  connection.setConfiguration({iceTransportPolicy:"all"});
  assert.equal(connection.getConfiguration().iceTransportPolicy,"relay");
  vm.runInContext(runtimePolicyScript({webrtcDisabled:true}),context);
  assert.equal(context.RTCPeerConnection,undefined);
  vm.runInContext(`(${restoreRuntimePolicy.toString()})()`,context);
  assert.equal(context.RTCPeerConnection,RTC);
  const native = new RTC(); native.setConfiguration({iceTransportPolicy:"all"});
  assert.equal(native.getConfiguration().iceTransportPolicy,"all");
  assert.equal(verifyRuntimePolicy({webrtcRelayOnly:true},{}),false);
});

test("字体屏蔽改变实际 Canvas/FontFaceSet 访问，支持数量配置和恢复", () => {
  class Context {
    _font = "10px sans-serif";
    get font() { return this._font; } set font(value) { this._font = value; }
    measureText() { const base = this.font.includes("monospace") ? 100 : this.font.includes("serif") && !this.font.includes("sans-serif") ? 300 : 200; return { width: base + (/"(?:Microsoft YaHei|SimSun|SimHei|MingLiU)"/.test(this.font) ? 15 : 0) }; }
    fillText() {} strokeText() {}
  }
  class Fonts { check() { return true; } load() { return Promise.resolve(["loaded"]); } }
  class Nav { get languages() { return ["zh-CN", "zh"]; } get language() { return "zh-CN"; } }
  const context = vm.createContext({ CanvasRenderingContext2D: Context, FontFaceSet: Fonts, Navigator: Nav, navigator: new Nav(), RTCPeerConnection: function RTC() {}, document: { createElement: () => ({ getContext: () => new Context() }) }, location: { hostname: "localhost" } });
  const execute = (policy) => vm.runInContext(runtimePolicyScript(policy), context);
  try {
    const none = execute({ fontMode: "none", languages: ["en-US"], locale: "en-US", webrtcDisabled: true });
    assert.equal(none.simplified.length, 0); assert.equal(none.traditional.length, 0);
    assert.equal(verifyRuntimePolicy({ fontMode: "none", languages: ["en-US"], locale: "en-US", webrtcDisabled: true }, none), true);
    assert.equal(new Fonts().check('16px "Microsoft YaHei"'), false);
    assert.equal(new Fonts().check('16px Arial'), true);
    assert.equal(execute({ fontMode: "one" }).simplified.length, 1);
    assert.equal(execute({ fontMode: "two" }).simplified.length, 2);
    const traditional = execute({ fontMode: "traditional" });
    assert.equal(traditional.simplified.length, 0); assert.equal(traditional.traditional.length, 1);
    assert.equal(verifyRuntimePolicy({ fontMode: "three" }, traditional), false);
    vm.runInContext(`(${restoreRuntimePolicy.toString()})()`, context);
    assert.equal(new Fonts().check('16px "Microsoft YaHei"'), true);
    assert.equal(context.navigator.language, "zh-CN");
    assert.equal(typeof context.RTCPeerConnection, "function");
  } finally { vm.runInContext(`(${restoreRuntimePolicy.toString()})()`, context); }
});

test("实际 Chromium 首次页面脚本、刷新、变更、撤销都使用目标接口；本地验证不冒充 Claude 端验证", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkcc-runtime-test-"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<html><script>window.firstProbe={protected:!!globalThis[Symbol.for('checkcc.runtime-policy.v1')],fontAllowed:document.fonts.check('16px "Microsoft YaHei"'),language:navigator.language};</script><body>Controlled runtime test</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = new EnvironmentRuntime({ stateDir: directory, headless: true });
  const profileFile = path.join(directory, "gateway-profile.json");
  await writeFile(profileFile, JSON.stringify({ target: { language: "ko-KR", locale: "ko-KR" }, updatedAt: "first" }));
  const gateway = createGateway({ upstreamBase: origin, profileFile });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const controller = new BrowserCloakController(runtime, { gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, intervalMs: 1000000 });
  const initialCloak = cloakState().enabled;
  const findPage = async (predicate) => {
    const instance = runtime.clients.get("web");
    for (let attempt = 0; attempt < 25; attempt++) {
      await Promise.all([...instance.tasks]);
      for (const sessionId of instance.sessions.keys()) {
        const result = await instance.client.send("Runtime.evaluate", { expression: "({origin:location.origin,probe:globalThis.firstProbe})", returnByValue: true }, sessionId).catch(() => null);
        if (result?.result?.value?.origin === origin && predicate(result.result.value.probe)) return { instance, sessionId, probe: result.result.value.probe };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Target observation missing: " + JSON.stringify({sessions:instance.sessions.size,errors:instance.errors,targets:(await instance.client.send("Target.getTargets")).targetInfos.map(t=>({type:t.type,url:t.url}))}));
  };
  try {
    const first = await runtime.apply({ fontMode: "none", languages: ["en-US"], locale: "en-US" }, origin, ["web"]);
    assert.notEqual(first.results[0].state, "verified", "a localhost page cannot prove Claude-site integration");
    const page = await findPage((probe) => probe?.protected);
    assert.equal(page.probe.fontAllowed, false); assert.equal(page.probe.language, "en-US");
    const sample = await page.instance.client.send("Runtime.evaluate", { expression: runtimePolicyScript(runtime.policy), returnByValue: true }, page.sessionId);
    assert.equal(verifyRuntimePolicy(runtime.policy, sample.result.value), true);
    await page.instance.client.send("Page.reload", {}, page.sessionId);
    assert.equal((await findPage((probe) => probe?.protected)).probe.fontAllowed, false);
    await runtime.apply({ languages: ["ko-KR"], locale: "ko-KR", webrtcDisabled: true }, origin, ["web"]);
    const updated = await page.instance.client.send("Runtime.evaluate", { expression: "({language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,rtc:typeof RTCPeerConnection})", returnByValue: true }, page.sessionId);
    assert.deepEqual(updated.result.value, { language: "ko-KR", locale: "ko-KR", rtc: "undefined" });
    setCloak(true);
    const linked = await controller.sync(origin, { force: true });
    assert.equal(linked.enabled, true);
    assert.equal(linked.policy.webrtcDisabled, false);
    assert.equal(linked.policy.webrtcRelayOnly, true);
    const ice = await page.instance.client.send("Runtime.evaluate", {expression: `(async () => {
      const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}],iceTransportPolicy:"all"});
      try {
        pc.setConfiguration({iceServers:[{urls:"stun:stun.l.google.com:19302"}],iceTransportPolicy:"all"});
        pc.createDataChannel("privacy-test");
        const candidates = [];
        await new Promise(async (resolve,reject) => {
          const timer = setTimeout(() => reject(new Error("ICE gathering timeout")),3000);
          pc.onicecandidate = event => { if(event.candidate) candidates.push(event.candidate.candidate); else {clearTimeout(timer);resolve();} };
          try { await pc.setLocalDescription(await pc.createOffer()); } catch(error) {clearTimeout(timer);reject(error);}
        });
        return {policy:pc.getConfiguration().iceTransportPolicy,candidates,native:pc instanceof RTCPeerConnection};
      } finally {pc.close();}
    })()`, awaitPromise:true, returnByValue:true}, page.sessionId);
    assert.equal(ice.exceptionDetails, undefined);
    assert.deepEqual(ice.result.value,{policy:"relay",candidates:[],native:true});
    assert.equal(linked.requestProbe.state, "verified");
    assert.match(linked.requestProbe.receivedLanguage, /^ko-KR,/);
    assert.notEqual(linked.results.find(item=>item.target==="web").state, "verified", "only a local page is open; Claude-page coverage stays unverified");
    setCloak(false);
    const disabled = await controller.sync(origin, { force: true });
    assert.equal(disabled.enabled, false);
    assert.equal(runtime.enabled, false);
    await page.instance.client.send("Page.reload", {}, page.sessionId);
    assert.equal((await findPage((probe) => probe?.protected === false)).probe.protected, false);
    await writeFile(profileFile, JSON.stringify({ target: { language: "en", locale: "en-US" }, updatedAt: "second" }));
    setCloak(true);
    const changed = await controller.sync(origin, { force: true });
    assert.equal(changed.requestProbe.state, "verified");
    assert.match(changed.requestProbe.receivedLanguage, /^en-US,/);
    assert.equal(changed.policy.languages[0], "en-US");
    await controller.close();
    const baseline = page.instance.sessions.get(page.sessionId).baseline;
    const restored = await runtime.restore(); assert.equal(restored.results[0].state, "restored");
    const native = await page.instance.client.send("Runtime.evaluate", { expression: "({languages:[...navigator.languages],locale:Intl.DateTimeFormat().resolvedOptions().locale})", returnByValue: true }, page.sessionId);
    assert.deepEqual(native.result.value, baseline);
    await page.instance.client.send("Page.reload", {}, page.sessionId);
    assert.equal((await findPage((probe) => probe?.protected === false)).probe.protected, false);
    await runtime.apply({ fontMode: "none", languages: ["en-US"], locale: "en-US" }, origin, ["web"]);
    const cleanup = await runtime.close();
    assert.ok(cleanup.results.every((item) => item.state === "restored"));
    assert.equal(JSON.parse(await readFile(path.join(directory, "environment-policy.json"), "utf8")).fontMode, "none", "controlled shutdown restores active pages while preserving the requested configuration");
  } finally {
    await controller.close(); setCloak(initialCloak);
    await runtime.close(); gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

test("本机助手自动启动后，执行请求需要本机来源、会话令牌和白名单配置", { timeout: 15000 }, async () => {
  const helperState = await mkdtemp(path.join(tmpdir(), "checkcc-helper-test-"));
  const originalState = process.env.CHECKCC_STATE_DIR;
  process.env.CHECKCC_STATE_DIR = helperState;
  const { startRepairHelper } = await import("./local-repair.mjs");
  if (originalState === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = originalState;
  const helper = await startRepairHelper(0);
  const headers = { Origin: "http://localhost:3000", "X-CheckCC-Client": "repair-ui", "Content-Type": "application/json" };
  try {
    const blocked = await fetch(`${helper.url}/session`, { headers: { ...headers, Origin: "https://example.com" } });
    assert.equal(blocked.status, 403);
    const session = await (await fetch(`${helper.url}/session`, { headers })).json();
    assert.equal(session.environmentScripts, 1);
    assert.equal(session.browserCloak, 1);
    const unauthorized = await fetch(`${helper.url}/environment`, { method: "POST", headers, body: JSON.stringify({ policy: { fontMode: "none" } }) });
    assert.equal(unauthorized.status, 403);
    const invalid = await fetch(`${helper.url}/environment`, { method: "POST", headers: { ...headers, "X-CheckCC-Token": session.token }, body: JSON.stringify({ policy: { country: "KR" } }) });
    assert.equal(invalid.status, 400);
  } finally { await helper.closeRuntime(); helper.server.closeAllConnections(); await new Promise((resolve) => helper.server.close(resolve)); await rm(helperState, { recursive: true, force: true }); }
});

test("浏览器接入时网关版本变化会撤销覆盖，不会返回旧配置的通过状态", async () => {
  let reads = 0, suspended = 0;
  const gateway = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ version: 1, cloak: { enabled: true, updatedAt: String(++reads) }, profile: { language: "en", locale: "en-US", updatedAt: "one" } })); });
  await new Promise(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  const runtime = { clients: new Map(), policy: {}, load: async()=>{}, apply: async()=>({policy:{},results:[],appliedAt:"now"}), probeBrowserHeaders: async()=>({state:"unverified"}), suspend: async()=>{suspended++;} };
  const controller = new BrowserCloakController(runtime, { gatewayUrl: `http://127.0.0.1:${gateway.address().port}` });
  try { await assert.rejects(controller.sync("http://localhost:3000"),/发生变化/); assert.equal(suspended,1); assert.equal(controller.report,null); }
  finally { await controller.close(); gateway.closeAllConnections(); await new Promise(resolve=>gateway.close(resolve)); }
});

test("已撤销或目标页面变化后不能复用缓存通过，连接失败会使旧报告失效", async () => {
  let available = true, rendererAvailable = true, applies = 0, inspections = 0;
  const gateway = http.createServer((_request, response) => { response.writeHead(available ? 200 : 503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ version: 1, cloak: { enabled: true, updatedAt: "one" }, profile: { language: "ko-KR", locale: "ko-KR", updatedAt: "one" } })); });
  await new Promise(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  const runtime = {
    clients: new Map([["web", {}]]), policy: {}, enabled: false, load: async()=>{},
    async apply(policy) { applies++; this.policy=policy; this.enabled=true; return {policy,results:[{target:"web",state:"verified",detail:"sample",pages:1}],appliedAt:"now"}; },
    async inspectCurrent() { inspections++; return {policy:this.policy,results:[{target:"web",state:rendererAvailable?"verified":"unverified",detail:"current",pages:rendererAvailable?1:0}],appliedAt:"now"}; },
    probeBrowserHeaders: async()=>({state:"verified",receivedLanguage:"ko-KR"}),
    async suspend() { this.enabled=false; return {policy:{},results:[],appliedAt:"now"}; },
  };
  const controller = new BrowserCloakController(runtime, { gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, intervalMs:1000000 });
  try {
    assert.equal((await controller.sync("http://localhost:3000")).results[0].state,"verified");
    await runtime.suspend();
    const reapplied=await controller.sync("http://localhost:3000");
    assert.equal(applies,2); assert.equal(runtime.enabled,true); assert.equal(reapplied.results[0].state,"verified");
    rendererAvailable=false;
    const departed=await controller.sync("http://localhost:3000");
    assert.equal(inspections,1); assert.equal(departed.results[0].state,"unverified");
    available=false;
    await assert.rejects(controller.sync("http://localhost:3000"),/无法读取/);
    assert.equal(controller.report,null); assert.equal(runtime.enabled,false);
  } finally { await controller.close(); gateway.closeAllConnections(); await new Promise(resolve=>gateway.close(resolve)); }
});

test("跨域 iframe 刷新与关闭后仍能恢复原始接口，重复恢复幂等", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkcc-restore-frames-"));
  const server = http.createServer((req, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(req.url === "/child" ? "<html>child</html>" : '<html><iframe src="http://localhost:' + server.address().port + '/child"></iframe></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const runtime = new EnvironmentRuntime({ stateDir: directory, headless: true, networkProxy: null });
  try {
    await runtime.apply({ languages: ["ko-KR", "ko"], locale: "ko-KR" }, origin, ["web"]);
    const instance = runtime.clients.get("web");
    const waitForFrame = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.all([...instance.tasks]);
        if ([...instance.sessions.values()].some(item => item.type === "iframe")) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("cross-origin frame did not attach");
    };
    await waitForFrame();
    for (const [sessionId, registration] of instance.sessions) {
      if (registration.type === "page") await instance.client.send("Page.reload", {}, sessionId);
    }
    await waitForFrame();
    assert.ok([...instance.sessions.values()].every(item => item.baseline), "every attached frame needs native restoration values");
    assert.ok((await runtime.restore()).results.every(item => item.state === "restored"));
    for (const [sessionId, registration] of instance.sessions) {
      const observed = await instance.client.send("Runtime.evaluate", { expression: "({languages:[...navigator.languages],locale:Intl.DateTimeFormat().resolvedOptions().locale,protected:!!globalThis[Symbol.for('checkcc.runtime-policy.v1')]})", returnByValue: true }, sessionId);
      assert.deepEqual(observed.result.value, { ...registration.baseline, protected: false });
    }
    for (const [sessionId, registration] of instance.sessions) {
      if (registration.type === "page") await instance.client.send("Runtime.evaluate", { expression: "document.querySelector('iframe')?.remove()" }, sessionId);
    }
    for (let attempt = 0; attempt < 20 && [...instance.sessions.values()].some(item => item.type === "iframe"); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok([...instance.sessions.values()].every(item => item.type !== "iframe"));
    assert.ok((await runtime.restore()).results.every(item => item.state === "restored"));
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(directory.startsWith(path.join(tmpdir(), "checkcc-restore-frames-")));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
