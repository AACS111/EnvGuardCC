import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { selectedProxy } from "./gateway-proxy.mjs";
import { stopManagedProcess } from "./managed-process.mjs";
import { runtimePolicyScript, verifyRuntimePolicy, migrateRuntimePolicy } from "../src/detection/runtime-policy.mjs";
import { findBrowser, findDesktop } from "./application-paths.mjs";
import { seedManagedProfile } from "./browser-catalog.mjs";

export { findBrowser, findDesktop };
export function validatePolicy(delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw new Error("无效环境配置。");
  const result = {};
  for (const [key, value] of Object.entries(delta)) {
    // undefined 视为未设置（JSON 里不会出现），不能当成未知字段拒掉。
    if (value === undefined) continue;
    if (key === "fontMode" && ["none", "traditional", "one", "two", "three"].includes(value)) result[key] = value;
    else if (key === "vendorFontLimit" && [0, 1, 2].includes(value)) result[key] = value;
    else if (key === "languages" && Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every((item) => typeof item === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item))) { Intl.getCanonicalLocales(value); result[key] = value; }
    else if (key === "locale" && typeof value === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) { Intl.getCanonicalLocales(value); result[key] = value; }
    // 声明面时区：只接受 IANA 名称（用 Intl 验证）与合法的 UTC 偏移（UTC-12…UTC+14）。
    else if (key === "timezone" && typeof value === "string" && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) {
      // 非法 IANA 名会在构造时抛 RangeError；换成可读错误，避免把英文异常堆给界面。
      try { new Intl.DateTimeFormat("en-US", { timeZone: value }); } catch { throw new Error(`不支持的时区：${value}`); }
      result[key] = value;
    }
    else if (key === "offsetMinutes" && Number.isInteger(value) && value >= -720 && value <= 840) result[key] = value;
    else if (key === "uaPlatform" && ["Windows", "macOS", "Linux", "Android", "iOS", "Chrome OS"].includes(value)) result[key] = value;
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
  pending = new Map(); listeners = new Set(); counter = 0; closed = false;
  constructor(write, close) { this.write = write; this.closeTransport = close; }
  receive(raw) {
    const message = JSON.parse(raw);
    if (message.id) { const task = this.pending.get(message.id); if (!task) return; clearTimeout(task.timer); this.pending.delete(message.id); if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result); }
    else for (const listener of this.listeners) listener(message);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      // 7s 在慢机器/首次导航时容易误判超时；默认 20s，可用环境变量覆盖。
      const timeoutMs = Number(process.env.CHECKCC_CDP_TIMEOUT || 20000);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`客户端没有响应：${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error("环境连接已关闭")); }
    this.pending.clear();
    this.closeTransport();
  }
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

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * 清掉上一次遗留的受管进程。
 * Chrome 会把「同 user-data-dir 的新启动」委托给已运行实例，并把命令行里的非开关 token
 * （可执行文件路径、--host-resolver-rules 里的 * / ~NOTFOUND / EXCLUDE / 127.0.0.1 / localhost）
 * 当成 URL 逐个打开。所以每次接入前必须先确保旧实例已退出。
 */
async function clearStaleManaged(pidFile) {
  let stale = null;
  try { stale = Number((await readFile(pidFile, "utf8")).trim()); }
  catch { /* 没有记录：首次接入或已被清理 */ }
  if (Number.isInteger(stale) && stale > 1 && pidAlive(stale)) {
    try { process.kill(stale); } catch { /* 已被别的途径结束 */ }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(stale)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (pidAlive(stale)) throw new Error("上一次的受管浏览器仍在运行，请先手动关闭它再接入。");
  }
  await rm(pidFile, { force: true }).catch(() => {});
}

export class EnvironmentRuntime {
  clients = new Map(); policy = {}; loaded = false; enabled = true;
  constructor({ stateDir, browserPath, browserPathProvider, headless = false, networkProxy }) { this.stateDir = stateDir; this.browserPath = browserPath; this.browserPathProvider = browserPathProvider; this.headless = headless; this.networkProxy = networkProxy; }
  // macOS 的浏览器清单给的是 .app bundle；直接 spawn bundle 会 EACCES。接入时解析到真正的可执行文件。
  // 受管浏览器由偏好决定：provider 优先，其次显式路径，最后才回退到默认候选。
  async managedBrowser() {
    const value = this.browserPathProvider ? await this.browserPathProvider() : (this.browserPath ?? await findBrowser());
    // provider 可以只给路径（旧约定）或 { id, path }（便于按浏览器取书签）。
    const browser = typeof value === "string" ? { id: null, path: value } : value;
    // Windows Chrome 对含空格的正斜杠程序路径解析异常，会把路径和开关当成网址。
    // 在启动边界统一为原生路径，同时覆盖清单、显式路径及 provider。
    if (process.platform === "darwin" && browser.path.endsWith(".app")) {
      browser.path = path.join(browser.path, "Contents", "MacOS", path.basename(browser.path, ".app"));
    }
    return process.platform === "win32" ? { ...browser, path: path.normalize(browser.path) } : browser;
  }
  async load() {
    if (this.loaded) return;
    try { this.policy = validatePolicy(migrateRuntimePolicy(JSON.parse(await readFile(path.join(this.stateDir, "environment-policy.json"), "utf8")))); } catch { this.policy = {}; }
    this.loaded = true;
  }
  source(origin) {
    if (!this.enabled || !Object.keys(this.policy).length) return "void 0";
    const install = runtimePolicyScript(this.policy);
    return `(() => { const u = new URL(location.href); if (u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai') || u.origin === ${JSON.stringify(origin)} || u.protocol === 'file:') return ${install}; return null; })()`;
  }
  async launch(kind, origin) {
    const startPage = this.headless ? "about:blank" : "https://www.google.com/";
    const profile = path.join(this.stateDir, `protected-${kind}`);
    await mkdir(profile, { recursive: true });
    // 同 profile 的旧实例会委托接管本次启动，并把命令行当成 URL 打开（会刷出一堆垃圾标签页）。
    const pidFile = path.join(this.stateDir, `managed-${kind}.pid`);
    await clearStaleManaged(pidFile);
    // 受管 profile 里若残留上次的会话，下次打开会把那些垃圾标签页恢复回来。
    for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
      await rm(path.join(profile, "Default", name), { force: true }).catch(() => {});
    }
    // Use the same real upstream as the gateway, without sending proxy credentials to argv.
    const networkProxy = this.networkProxy === undefined ? selectedProxy() : this.networkProxy;
    const networkArgs = browserNetworkArgs(networkProxy);
    let client, child, spawnError;
    // 受管浏览器由偏好决定；provider 可返回路径或 { id, path }。
    const chosen = kind === "web" ? await this.managedBrowser() : null;
    // 受管实例默认是干净配置：只补一份书签，登录态/扩展/Cookie 一律不复制。
    if (chosen) { try { await seedManagedProfile({ browserId: chosen.id, profileDir: profile }); } catch { /* 书签是附加项，失败不影响接入 */ } }    // headless 走 pipe（实测稳定）；Windows 上 headful 必须走 port，因为 Chrome 自我重启时管道会断。
    // headful 的 Chrome 可能重执行/脱离管道；macOS 的 headful 必须走固定调试端口，只有 headless 用 pipe 才稳定。
    const usePortChannel = kind !== "web" || !this.headless;
    if (!usePortChannel) {
      child = spawn(chosen.path, [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", ...networkArgs, ...(this.headless ? ["--headless=new", "--disable-gpu"] : []), startPage], { windowsHide: this.headless, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
      child.on("error", (error) => { spawnError = error; });
      client = new DebugConnection((text) => child.stdio[3].write(text + "\0"), () => child.stdio[3].end());
      let buffer = "";
      child.stdio[3].on("error", () => client.disconnect());
      child.stdio[4].on("data", (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf("\0")) >= 0) { const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (raw) client.receive(raw); } });
    } else {
      if (kind !== "web" && process.platform === "darwin") throw new Error("当前 macOS Claude 未提供可验证的独立调试接入，请使用受控浏览器；未修改个人客户端资料。");
      const port = await unusedPort();
      const executable = kind === "web" ? chosen.path : await findDesktop();
      // 受管实例是全新 profile：不带 --no-first-run 会打开首次运行页（Windows 上那个页面会自动下载 Chrome 安装包，
      // 表现就是每点一次接入多一个 chrome (N).exe）。桌面上启动 Claude 时这些开关无害。
      child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", ...networkArgs, ...(this.headless ? ["--headless=new", "--disable-gpu"] : []), startPage], { windowsHide: this.headless, stdio: "ignore" });
      child.on("error", (error) => { spawnError = error; });
      child.unref();
      let endpoint;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) })).json(); const url = new URL(info.webSocketDebuggerUrl); if (url.hostname === "127.0.0.1" || url.hostname === "localhost") { if (Number(url.port) === port && url.pathname.startsWith("/devtools/browser/")) { endpoint = url.href; break; } } } catch { /* Wait for this explicitly launched instance. */ }
        if (child.exitCode !== null || spawnError) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!endpoint) throw new Error(kind === "web" ? "受管浏览器未开放脚本接入：请先关闭使用同一配置目录的浏览器后重试。" : "桌面端未开放脚本接入。若客户端已运行，请先正常退出后重试；当前版本也可能禁用了调试接入。未修改桌面端或系统字体。");
      const socket = new WebSocket(endpoint);
      await new Promise((resolve, reject) => { const timeout = setTimeout(() => { socket.close(); reject(new Error(kind === "web" ? "受管浏览器接入超时" : "桌面端接入超时")); }, 3000); socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(kind === "web" ? "受管浏览器接入失败" : "桌面端接入失败")); }, { once: true }); });
      client = new DebugConnection((text) => socket.send(text), () => socket.close());
      socket.addEventListener("message", (event) => client.receive(event.data));
      socket.addEventListener("close", () => { if (this.clients.get(kind)?.client === client) this.clients.delete(kind); });
    }
    child.on("error", () => { client?.disconnect(); });
    // 记下 pid：下次接入前要先把旧实例清掉（否则会被委托接管并刷出垃圾标签页）。
    if (child.pid) { try { await writeFile(pidFile, String(child.pid), { mode: 0o600 }); } catch { /* 记不下来也不阻断接入 */ } }
    const instance = { kind, child, client, origin, networkKey: networkProxy?.url.href || null, sessions: new Map(), tasks: new Set(), errors: [] };
    child.once("exit", () => { if (this.clients.get(kind) === instance) this.clients.delete(kind); client.disconnect(); void rm(pidFile, { force: true }).catch(() => {}); });
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
            await this.configure(instance, sessionId, { evaluate: false });
            // Recursively catch cross-origin renderer frames before their scripts run.
            await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
            // A replacement iframe can defer evaluation while waiting for the
            // debugger. Its document script and emulation are already installed,
            // so resume before evaluating the current document.
            await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
            await client.send("Runtime.evaluate", { expression: this.source(origin), returnByValue: true }, sessionId);
          }
        } catch (error) { instance.errors.push(error.message); }
        finally { await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}); }
      })();
      instance.tasks.add(task); task.finally(() => instance.tasks.delete(task));
    });
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // 受管实例只用于验证声明面，不需要下载能力：禁掉下载，避免任何页面（首次运行页/promo/重定向）
    // 往用户目录写文件（典型症状：每点一次接入就多一个 chrome (N).exe）。
    await client.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
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
      // 只有 headless 测试实例需要本地验证页；用户可见的受管浏览器只保留启动页（Google），
      // 不再额外打开 EnvGuardCC 本地页和 Claude 验证页。
      if (this.headless) await createPage(origin);
    }
    return instance;
  }
  async configure(instance, sessionId, { evaluate = true } = {}) {
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
    if (evaluate) return client.send("Runtime.evaluate", { expression: this.source(instance.origin), returnByValue: true }, sessionId);
  }
  async apply(delta, origin, kinds = ["web", "desktop"]) {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("仅支持本机检测页面。");
    await this.load();
    this.policy = { ...this.policy, ...validatePolicy(delta) };
    this.enabled = true;
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, "environment-policy.json");
    await writeFile(file + ".tmp", JSON.stringify(this.policy), { mode: 0o600 }); await rename(file + ".tmp", file);
    const results = await Promise.all(kinds.map(async (kind) => {
      try {
        if (!["web", "desktop"].includes(kind)) throw new Error("不支持的执行环境");
        let existing = this.clients.get(kind);
        // 上一次启动失败/浏览器已退出时，clients 里可能留下死实例；不清理会让后续每次重试都报“环境连接已关闭”。
        if (existing && (existing.client.closed || existing.child.exitCode !== null)) {
          try { existing.client.disconnect(); } catch { /* 已断开 */ }
          await stopManagedProcess(existing.child).catch(() => {});
          this.clients.delete(kind);
          existing = undefined;
        }
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
        await rm(path.join(this.stateDir, `managed-${kind}.pid`), { force: true }).catch(() => {});
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
