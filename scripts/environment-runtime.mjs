import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { selectedProxy } from "./gateway-proxy.mjs";
import { stopManagedProcess } from "./managed-process.mjs";
import { runtimePolicyScript, verifyRuntimePolicy, migrateRuntimePolicy } from "../src/detection/runtime-policy.mjs";
import { findBrowser, findDesktop } from "./application-paths.mjs";

export { findBrowser, findDesktop };
export function validatePolicy(delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw new Error("无效环境配置。");
  const result = {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === "fontMode" && ["none", "traditional", "one", "two", "three"].includes(value)) result[key] = value;
    else if (key === "vendorFontLimit" && [0, 1, 2].includes(value)) result[key] = value;
    else if (key === "languages" && Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every((item) => typeof item === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item))) { Intl.getCanonicalLocales(value); result[key] = value; }
    else if (key === "locale" && typeof value === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) { Intl.getCanonicalLocales(value); result[key] = value; }
    else if ((key === "webrtcDisabled" || key === "webrtcRelayOnly") && typeof value === "boolean") result[key] = value;
    else throw new Error(`不支持自动应用的字段：${key}`);
  }
  if (!Object.keys(result).length) throw new Error("没有可执行配置。");
  return result;
}

async function removeDocumentScript(client, identifier, sessionId) {
  try { await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId); }
  catch (error) {
    // Navigation can discard an old registration. Native interface restoration must still run.
    if (!/Script not found|No script with given identifier/i.test(error.message)) throw error;
  }
}

class DebugConnection {
  pending = new Map(); listeners = new Set(); counter = 0;
  constructor(write, close) { this.write = write; this.closeTransport = close; }
  receive(raw) {
    const message = JSON.parse(raw);
    if (message.id) { const task = this.pending.get(message.id); if (!task) return; clearTimeout(task.timer); this.pending.delete(message.id); if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result); }
    else for (const listener of this.listeners) listener(message);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`客户端没有响应：${method}`)); }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnect() { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error("环境连接已关闭")); } this.pending.clear(); this.closeTransport(); }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function browserNetworkArgs(proxy = selectedProxy()) {
  if (!proxy) return [];
  if (proxy.url.username || proxy.url.password) throw new Error("隔离浏览器暂不支持带认证的上游代理，请使用本机 HTTP 混合代理端口。");
  return [
    `--proxy-server=${proxy.url.origin}`, "--disable-quic",
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.url.hostname}, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]`,
  ];
}

export class EnvironmentRuntime {
  clients = new Map(); policy = {}; loaded = false; enabled = true;
  constructor({ stateDir, browserPath, headless = false, networkProxy }) { this.stateDir = stateDir; this.browserPath = browserPath; this.headless = headless; this.networkProxy = networkProxy; }
  async load() {
    if (this.loaded) return;
    try { this.policy = validatePolicy(migrateRuntimePolicy(JSON.parse(await readFile(path.join(this.stateDir, "environment-policy.json"), "utf8")))); } catch { this.policy = {}; }
    try { this.trafficScope = JSON.parse(await readFile(path.join(this.stateDir,"traffic-layer.json"),"utf8")); } catch { this.trafficScope = null; }
    this.loaded = true;
  }
  source(origin) {
    if (!this.enabled || !Object.keys(this.policy).length) return "void 0";
    const install = runtimePolicyScript(this.policy);
    const allWeb = this.trafficScope?.applied === true && this.trafficScope?.allOverseas === true;
    return `(() => { const u = new URL(location.href); if ((${JSON.stringify(allWeb)} && ['http:','https:'].includes(u.protocol)) || u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai') || u.origin === ${JSON.stringify(origin)} || u.protocol === 'file:') return ${install}; return null; })()`;
  }
  async launch(kind, origin) {
    const profile = path.join(this.stateDir, `protected-${kind}`);
    await mkdir(profile, { recursive: true });
    // Use the same real upstream as the gateway, without sending proxy credentials to argv.
    const networkProxy = this.networkProxy === undefined ? selectedProxy() : this.networkProxy;
    const networkArgs = browserNetworkArgs(networkProxy);
    let client, child, spawnError;
    if (kind === "web") {
      child = spawn(this.browserPath ?? await findBrowser(), [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", ...networkArgs, ...(this.headless ? ["--headless=new", "--disable-gpu"] : []), "about:blank"], { windowsHide: this.headless, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
      child.on("error", (error) => { spawnError = error; });
      client = new DebugConnection((text) => child.stdio[3].write(text + "\0"), () => child.stdio[3].end());
      let buffer = "";
      child.stdio[3].on("error", () => client.disconnect());
      child.stdio[4].on("data", (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf("\0")) >= 0) { const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (raw) client.receive(raw); } });
    } else {
      if (process.platform === "darwin") throw new Error("当前 macOS Claude 未提供可验证的独立调试接入，请使用受控浏览器；未修改个人客户端资料。");
      const port = await unusedPort();
      child = spawn(await findDesktop(), [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", ...networkArgs], { windowsHide: false, stdio: "ignore" });
      child.on("error", (error) => { spawnError = error; });
      child.unref();
      let endpoint;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) })).json(); const url = new URL(info.webSocketDebuggerUrl); if (url.hostname === "127.0.0.1" || url.hostname === "localhost") { if (Number(url.port) === port && url.pathname.startsWith("/devtools/browser/")) { endpoint = url.href; break; } } } catch { /* Wait for this explicitly launched instance. */ }
        if (child.exitCode !== null || spawnError) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!endpoint) throw new Error("桌面端未开放脚本接入。若客户端已运行，请先正常退出后重试；当前版本也可能禁用了调试接入。未修改桌面端或系统字体。");
      const socket = new WebSocket(endpoint);
      await new Promise((resolve, reject) => { const timeout = setTimeout(() => { socket.close(); reject(new Error("桌面端接入超时")); }, 3000); socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("桌面端接入失败")); }, { once: true }); });
      client = new DebugConnection((text) => socket.send(text), () => socket.close());
      socket.addEventListener("message", (event) => client.receive(event.data));
      socket.addEventListener("close", () => { if (this.clients.get(kind)?.client === client) this.clients.delete(kind); });
    }
    child.on("error", () => { client?.disconnect(); });
    const instance = { kind, child, client, origin, networkKey: networkProxy?.url.href || null, sessions: new Map(), tasks: new Set(), errors: [] };
    child.once("exit", () => { if (this.clients.get(kind) === instance) this.clients.delete(kind); client.disconnect(); });
    client.listeners.add((event) => {
      if (event.method === "Target.detachedFromTarget") instance.sessions.delete(event.params.sessionId);
      if (event.method !== "Target.attachedToTarget") return;
      const { sessionId, targetInfo } = event.params;
      const task = (async () => {
        try {
          if (["page", "iframe"].includes(targetInfo.type)) {
            await client.send("Page.enable", {}, sessionId);
            const registration = await client.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source(origin) }, sessionId);
            instance.sessions.set(sessionId, { script: registration.identifier, type: targetInfo.type, targetId: targetInfo.targetId });
            await this.configure(instance, sessionId);
            // Recursively catch cross-origin renderer frames before their scripts run.
            await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
          }
        } catch (error) { instance.errors.push(error.message); }
        finally { await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}); }
      })();
      instance.tasks.add(task); task.finally(() => instance.tasks.delete(task));
    });
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await Promise.all([...instance.tasks]);
    this.clients.set(kind, instance);
    if (kind === "web") {
      const createPage = async (url) => {
        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        for (let attempt = 0; attempt < 20; attempt++) {
          await Promise.all([...instance.tasks]);
          const entry = [...instance.sessions].find(([, item]) => item.targetId === targetId);
          if (entry) { await client.send("Page.navigate", { url }, entry[0]); return; }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("无法在页面首次脚本运行前安装环境保护。");
      };
      await createPage(origin);
      if (!this.headless) {
        await createPage("https://claude.ai/");
      }
    }
    return instance;
  }
  async configure(instance, sessionId) {
    const { client } = instance;
    const registration = instance.sessions.get(sessionId);
    if (registration && !registration.baseline) {
      // Subframes can attach before they have an execution context. Capture the
      // browser's native values once, before applying any emulation, and share them.
      instance.baseline ??= client.send("Runtime.evaluate", { expression: "(() => { const s = globalThis[Symbol.for('checkcc.runtime-policy.v1')]; return {languages:s?.languages ?? [...navigator.languages],locale:(s?.intl.DateTimeFormat ?? Intl.DateTimeFormat)().resolvedOptions().locale}; })()", returnByValue: true }, sessionId).then(result => {
        if (!result.result?.value) { instance.baseline = null; throw new Error("无法读取浏览器原始语言与区域，未应用覆盖。"); }
        return result.result.value;
      }).catch(error => { instance.baseline = null; throw error; });
      registration.baseline = structuredClone(await instance.baseline);
    }
    if (this.enabled && this.policy.languages) {
      const { userAgent } = await client.send("Browser.getVersion");
      await client.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: this.policy.languages.join(",") }, sessionId);
    }
    if (this.enabled && this.policy.locale) await client.send("Emulation.setLocaleOverride", { locale: this.policy.locale }, sessionId);
    return client.send("Runtime.evaluate", { expression: this.source(instance.origin), returnByValue: true }, sessionId);
  }
  async apply(delta, origin, kinds = ["web", "desktop"]) {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("仅支持本机检测页面。");
    await this.load();
    try { this.trafficScope = JSON.parse(await readFile(path.join(this.stateDir,"traffic-layer.json"),"utf8")); } catch { this.trafficScope = null; }
    this.policy = { ...this.policy, ...validatePolicy(delta) };
    this.enabled = true;
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, "environment-policy.json");
    await writeFile(file + ".tmp", JSON.stringify(this.policy), { mode: 0o600 }); await rename(file + ".tmp", file);
    const results = await Promise.all(kinds.map(async (kind) => {
      try {
        if (!["web", "desktop"].includes(kind)) throw new Error("不支持的执行环境");
        let existing = this.clients.get(kind);
        const proxy = this.networkProxy === undefined ? selectedProxy() : this.networkProxy;
        if (existing && existing.networkKey !== (proxy?.url.href || null)) {
          await stopManagedProcess(existing.child);
          existing.client.disconnect();
          this.clients.delete(kind);
          existing = undefined;
        }
        const instance = existing ?? await this.launch(kind, origin);
        const observations = [];
        await Promise.all([...instance.tasks]);
        for (const [sessionId, registration] of instance.sessions) {
          if (existing) { await removeDocumentScript(instance.client, registration.script, sessionId); const next = await instance.client.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source(instance.origin) }, sessionId); registration.script = next.identifier; }
          const result = await this.configure(instance, sessionId);
          if (result.result?.value) observations.push(result.result.value);
        }
        const verified = observations.some((sample) => sample.claudePage) && observations.every((sample) => verifyRuntimePolicy(this.policy, sample));
        return { target: kind, state: verified ? "verified" : "unverified", detail: verified ? "当前已接入页面的指定接口复测通过；新页面由启动器持续接入。不代表所有指纹接口或真实风控均通过。" : "脚本已尝试接入，但尚无足够的目标页面验证结果。请在受保护窗口打开对应页面后重试。", pages: observations.length };
      } catch (error) { return { target: kind, state: "failed", detail: error.message, pages: 0 }; }
    }));
    return { policy: this.policy, results, appliedAt: new Date().toISOString() };
  }
  async restore({ persist = true } = {}) {
    this.policy = {}; this.loaded = true; this.enabled = false;
    await mkdir(this.stateDir, { recursive: true });
    if (persist) await writeFile(path.join(this.stateDir, "environment-policy.json"), "{}", { mode: 0o600 });
    const results = [];
    for (const instance of this.clients.values()) {
      try {
        await Promise.all([...instance.tasks]);
        let verified = true;
        for (const [sessionId, registration] of instance.sessions) {
          try {
            await removeDocumentScript(instance.client, registration.script, sessionId);
            await instance.client.send("Emulation.setUserAgentOverride", { userAgent: "" }, sessionId);
            await instance.client.send("Emulation.setLocaleOverride", { locale: "" }, sessionId);
            await instance.client.send("Runtime.evaluate", { expression: `(() => { const key = Symbol.for('checkcc.runtime-policy.v1'); const s = globalThis[key]; if (s) { for (const [o,k,d] of s.originals.reverse()) Object.defineProperty(o,k,d); delete globalThis[key]; } })()` }, sessionId);
            const next = await instance.client.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source(instance.origin) }, sessionId); registration.script = next.identifier;
            const observed = await instance.client.send("Runtime.evaluate", { expression: "({languages:[...navigator.languages],locale:Intl.DateTimeFormat().resolvedOptions().locale,protected:!!globalThis[Symbol.for('checkcc.runtime-policy.v1')]})", returnByValue: true }, sessionId);
            const value = observed.result?.value;
            verified &&= Boolean(registration.baseline && value && !value.protected && JSON.stringify(value.languages) === JSON.stringify(registration.baseline.languages) && value.locale === registration.baseline.locale);
          } catch (error) {
            // A closed frame no longer has an override to restore. Continue with live pages.
            if (!instance.sessions.has(sessionId) || /Session with given id not found|No session with given id|Target closed/i.test(error.message)) { instance.sessions.delete(sessionId); continue; }
            throw error;
          }
        }
        results.push({ target: instance.kind, state: verified ? "restored" : "unverified", detail: verified ? "接口屏蔽与语言/区域覆盖均已撤销，并核对原始值。" : "已尝试撤销，但部分页面未能核对原始值，请重新打开受保护窗口。", pages: instance.sessions.size });
      } catch (error) { results.push({ target: instance.kind, state: "failed", detail: error.message, pages: 0 }); }
    }
    return { policy: {}, results, appliedAt: new Date().toISOString() };
  }
  async suspend() {
    await this.load();
    const desired = this.policy;
    const report = await this.restore({ persist: false });
    this.policy = desired;
    return report;
  }

  async probeBrowserHeaders(gatewayUrl) {
    const instance = this.clients.get("web");
    if (!instance) return { state: "unverified", detail: "受控浏览器未连接，无法验证实际请求头。" };
    for (const sessionId of instance.sessions.keys()) {
      try {
        const report = await instance.client.send("Runtime.evaluate", {
          expression: `(async () => { if (location.origin !== ${JSON.stringify(instance.origin)}) return null; const r = await fetch(${JSON.stringify(gatewayUrl + "/__checkcc/browser-probe")}, {headers:{'X-CheckCC-Client':'gateway-ui'},cache:'no-store'}); if (!r.ok) throw new Error('HTTP '+r.status); return await r.json(); })()`,
          awaitPromise: true, returnByValue: true,
        }, sessionId);
        const value = report.result?.value;
        if (!value) continue;
        const expected = this.policy.languages?.[0];
        const verified = value.kind === "browser-headers-probe" && Boolean(expected) && value.receivedLanguage?.split(",")[0].trim().toLowerCase() === expected.toLowerCase();
        return { state: verified ? "verified" : "unverified", receivedLanguage: value.receivedLanguage ?? "", sampledAt: value.sampledAt, detail: verified ? "网关受控接收端已收到浏览器实际发出的目标语言头。" : "收到的浏览器请求语言与目标不一致。" };
      } catch { /* Another target may still have the local verification page. */ }
    }
    return { state: "unverified", detail: "受控浏览器中未找到可执行接收端验证的本机页面，请保留启动器打开的检测页。" };
  }
  async inspectCurrent() {
    const results = [];
    for (const instance of this.clients.values()) {
      const observations = [];
      let failure = false;
      await Promise.all([...instance.tasks]);
      for (const sessionId of instance.sessions.keys()) {
        try {
          const response = await instance.client.send("Runtime.evaluate", { expression: this.source(instance.origin), returnByValue: true }, sessionId);
          if (response.exceptionDetails) failure = true;
          if (response.result?.value) observations.push(response.result.value);
        } catch { failure = true; }
      }
      const verified = this.enabled && !failure && observations.some((sample) => sample.claudePage) && observations.every((sample) => verifyRuntimePolicy(this.policy, sample));
      results.push({ target: instance.kind, state: verified ? "verified" : "unverified", detail: verified ? "当前仍打开的 Claude 页面指定接口已重新采样通过。" : "当前目标页面已关闭、离开 Claude，或接口尚未完成验证。", pages: observations.length });
    }
    if (!this.clients.has("web")) results.unshift({ target: "web", state: "unverified", detail: "受控浏览器未连接。", pages: 0 });
    return { policy: this.enabled ? this.policy : {}, results, appliedAt: new Date().toISOString() };
  }
  async close() {
    const restored = await this.restore({ persist: false });
    for (const [kind, { client, child }] of [...this.clients]) {
      try {
        await client.send("Browser.close").catch(() => {});
        await stopManagedProcess(child);
        client.disconnect(); this.clients.delete(kind);
        const result = restored.results.find(item => item.target === kind);
        if (result) Object.assign(result, { state: "restored", detail: "受控客户端已关闭，临时接口和代理配置已释放。" });
      } catch (error) {
        const result = restored.results.find(item => item.target === kind);
        if (result) Object.assign(result, { state: "failed", detail: error.message });
      }
    }
    return restored;
  }
}
