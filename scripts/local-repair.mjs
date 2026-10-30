// Optional Windows companion. Only explicit UI requests can change a whitelisted timezone.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProtectionService } from "./protection-service.mjs";
import { EnvironmentRuntime } from "./environment-runtime.mjs";
import { BrowserCloakController } from "./browser-cloak.mjs";
import { readWindowsTimezone, windowsSystemExecutable } from "./windows-timezone.mjs";
import { DesktopLauncher } from "./desktop-launcher.mjs";
import { HELPER_PROTOCOL, assertCurrentHelper, shutdownHelper } from "./helper-connection.mjs";

const exec = promisify(execFile);
const port = 3001;
const localOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const allowedZones = new Set([
  "Korea Standard Time", "Tokyo Standard Time", "China Standard Time", "Taipei Standard Time",
  "Singapore Standard Time", "SE Asia Standard Time", "Myanmar Standard Time", "India Standard Time",
  "Sri Lanka Standard Time", "Nepal Standard Time", "Bangladesh Standard Time", "Pakistan Standard Time",
  "Arabian Standard Time", "Arab Standard Time", "Arabic Standard Time", "Iran Standard Time",
  "Israel Standard Time", "Middle East Standard Time", "Turkey Standard Time", "Georgian Standard Time",
  "Caucasus Standard Time", "Azerbaijan Standard Time", "West Asia Standard Time", "Ekaterinburg Standard Time",
  "Omsk Standard Time", "N. Central Asia Standard Time", "North Asia Standard Time", "North Asia East Standard Time",
  "Yakutsk Standard Time", "Vladivostok Standard Time", "Magadan Standard Time", "Russia Time Zone 11",
  "Russia Time Zone 3", "Russian Standard Time", "Kaliningrad Standard Time", "Ulaanbaatar Standard Time",
  "GMT Standard Time", "Greenwich Standard Time", "Romance Standard Time", "W. Europe Standard Time",
  "Central Europe Standard Time", "Central European Standard Time", "GTB Standard Time", "FLE Standard Time",
  "Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
  "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time", "SA Pacific Standard Time",
  "E. South America Standard Time", "Argentina Standard Time", "Pacific SA Standard Time", "Venezuela Standard Time",
  "AUS Eastern Standard Time", "E. Australia Standard Time", "Cen. Australia Standard Time",
  "W. Australia Standard Time", "New Zealand Standard Time", "Egypt Standard Time",
  "South Africa Standard Time", "W. Central Africa Standard Time", "E. Africa Standard Time", "Morocco Standard Time",
]);
const secret = randomBytes(32).toString("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".check-cc-local");
const backupFile = path.join(stateDir, "timezone-backup.json");
const profileFile = path.join(stateDir, "region-profile.json");
const desktopLauncher = new DesktopLauncher({ stateDir });
let changing = false;
let protectionChanging = false;
let closing = false;
let closePending = null;
let initializing = true;
const environmentRuntime = new EnvironmentRuntime({ stateDir });
const browserCloak = new BrowserCloakController(environmentRuntime, { gatewayUrl: process.env.CHECKCC_GATEWAY_URL || "http://127.0.0.1:3010", acquire: () => { if (changing || protectionChanging || closing) return false; changing = true; return true; }, release: () => { changing = false; } });

const currentZone = () => readWindowsTimezone();
async function setZone(zone) {
  if (!allowedZones.has(zone)) {
    const known = (await exec(windowsSystemExecutable("tzutil.exe"), ["/l"], { windowsHide: true, timeout: 15000 })).stdout;
    if (!known.split(/\r?\n/).some((line) => line.trim() === zone)) throw new Error("无效的系统时区。");
  }
  await exec(windowsSystemExecutable("tzutil.exe"), ["/s", zone], { windowsHide: true, timeout: 15000 });
  if (await currentZone() !== zone) throw new Error("系统时区复核未通过。");
}
const protection = createProtectionService({ stateDir, runtime: environmentRuntime, browserCloak, currentZone, setZone, canTest: () => !changing && !protectionChanging && !closing });
async function readBackup() {
  try {
    const value = JSON.parse(await readFile(backupFile, "utf8"));
    return typeof value.timezone === "string" && value.timezone.length < 128 ? value : null;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function saveBackup(timezone) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(backupFile + ".tmp", JSON.stringify({ timezone, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(backupFile + ".tmp", backupFile);
}
function authenticated(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}
async function saveProfile(profile) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(profileFile + ".tmp", JSON.stringify(profile, null, 2), { mode: 0o600 });
  await rename(profileFile + ".tmp", profileFile);
}

// 只接受网关会用到的字段，且语言/时区格式必须合法；不写入任何本机环境。
async function readProfile() {
  try {
    const value = JSON.parse(await readFile(profileFile, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function validTarget(value) {
  if (!value || typeof value !== "object") return null;
  const lang = typeof value.language === "string" ? value.language : "";
  const locale = typeof value.locale === "string" ? value.locale : lang;
  const timezone = typeof value.timezone === "string" && /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(value.timezone) ? value.timezone : null;
  if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(lang)) return null;
  if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(locale)) return null;
  return {
    language: lang,
    locale,
    timezone,
    countryName: typeof value.countryName === "string" ? value.countryName.slice(0, 64) : null,
    city: typeof value.city === "string" ? value.city.slice(0, 64) : null,
  };
}

async function parseBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 2048) throw new Error("请求内容过大。");
  }
  return JSON.parse(body);
}

async function closeRuntime() {
  if (closePending) return closePending;
  closing = true;
  closePending = (async () => {
    while (changing || protectionChanging) await new Promise(resolve => setTimeout(resolve, 100));
    const issues = [];
    const attempt = async operation => { try { return await operation(); } catch (error) { issues.push(error.message); } };
    await attempt(() => browserCloak.close());
    await attempt(() => desktopLauncher.close());
    const protectionReport = await attempt(() => protection.stop({ shutdown: true }));
    if (protectionReport?.phase === "restore_failed") issues.push(...protectionReport.issues);
    const runtimeReport = await attempt(() => environmentRuntime.close());
    for (const result of runtimeReport?.results ?? []) if (result.state !== "restored") issues.push(result.detail);
    await attempt(async () => {
      const backup = await readBackup();
      if (!backup) return;
      if (await currentZone() !== backup.timezone) await setZone(backup.timezone);
      await rm(backupFile, { force: true });
    });
    if (issues.length) throw new Error([...new Set(issues)].join("；"));
    return runtimeReport;
  })().catch(error => { closing = false; closePending = null; desktopLauncher.closed = false; throw error; });
  return closePending;
}

const server = http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const origin = req.headers.origin;
  if (req.headers.host !== `127.0.0.1:${server.address()?.port ?? port}` || req.socket.remoteAddress !== "127.0.0.1" || !localOrigin.test(origin)) return send(403, { error: "仅允许本机 EnvGuardCC 页面访问。" });
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    if (!["GET", "POST"].includes(req.headers["access-control-request-method"])) return send(405, { error: "不支持的请求方法。" });
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CheckCC-Client, X-CheckCC-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.writeHead(204); return res.end();
  }
  if (req.headers["x-checkcc-client"] !== "repair-ui") return send(403, { error: "缺少客户端标识。" });
  if (initializing) return send(503, { error: "正在恢复上次配置，请稍候。" });
  if (closing && req.method === "POST" && req.url !== "/shutdown") return send(503, { error: "应用正在恢复配置并退出，请稍候。" });
  if (req.url === "/shutdown") {
    if (req.method !== "POST") return send(405, { error: "仅支持 POST。" });
    if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效。" });
    try {
      const body = req.headers["content-type"]?.startsWith("application/json") ? await parseBody(req) : {};
      await closeRuntime();
      if (body.stopServer === true) res.once("finish", () => server.close());
      return send(200, { restored: true });
    }
    catch (error) { return send(500, { error: error.message }); }
  }
  if (req.url === "/claude-desktop") {
    if (req.method === "GET") return send(200, desktopLauncher.snapshot());
    if (req.method !== "POST") return send(405, { error: "仅支持 GET/POST。" });
    if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效，请重新连接本机服务。" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "必须使用 JSON。" });
    if (changing || protectionChanging) return send(409, { error: "保护配置正在更新，请稍后启动 Claude。" });
    const protectionState = protection.report();
    if (!protectionState.enabled || !["active", "partial"].includes(protectionState.phase)) return send(409, { error: "请先开启保护，再启动 Claude。" });
    changing = true;
    try {
      const body = await parseBody(req);
      if (body.action !== "launch") return send(400, { error: "无效启动操作。" });
      return send(200, await desktopLauncher.launch(protectionState.target));
    } catch (error) { return send(400, { error: error.message }); }
    finally { changing = false; }
  }
  if (req.url === "/protection") {
    if (req.method === "GET") return send(200, protection.report());
    if (req.method !== "POST") return send(405, { error: "仅支持 GET/POST。" });
    if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效。" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "必须使用 JSON。" });
    try {
      const body = await parseBody(req);
      if (body.action === "observe") return send(200, protection.observe(body));
      if (body.action === "monitor") return send(200, protection.monitor(body.enabled, body.intervalMs));
      if (!["start", "stop", "test", "resume"].includes(body.action)) return send(400, { error: "无效操作。" });
      if (protectionChanging) return send(409, { error: "配置正在执行，请稍后重试。" });
      protectionChanging = true;
      try {
        // Reserve explicit protection actions so background sync cannot starve them.
        while (changing) await new Promise(resolve => setTimeout(resolve, 50));
        changing = true;
        try { return send(200, await (body.action === "test" ? protection.retest() : protection[body.action](origin))); } finally { changing = false; }
      } finally { protectionChanging = false; }
    } catch (error) { return send(400, { error: error.message }); }
  }
  if (req.method === "GET" && req.url === "/session?tokenOnly=1") return send(200, { token: secret });
  if (req.method === "GET" && req.url === "/session") {
    try { return send(200, { token: secret, helperProtocol: HELPER_PROTOCOL, shutdown: 1, desktopLauncher: 1, environmentScripts: 1, browserCloak: 1, platform: process.platform, timezone: process.platform === "win32" ? await currentZone() : "", canRestore: Boolean(await readBackup()), profile: await readProfile() }); }
    catch (error) {
      console.error("[repair] Session initialization failed:", error.message, error.cause?.code ?? error.code ?? "");
      return send(500, { error: "本机助手初始化失败：" + error.message });
    }
  }
  if (req.method === "POST" && ["/environment", "/environment/restore", "/browser-cloak"].includes(req.url)) {
    if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效，请重新打开详情。" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "必须使用 JSON。" });
    // Join an in-flight browser sync instead of reporting a configuration error.
    if (!protectionChanging && changing && req.url === "/browser-cloak" && browserCloak.pending) {
      const pending = browserCloak.pending;
      try {
        const body = await parseBody(req);
        if (body.launch === true) return send(409, { error: "浏览器正在同步，请稍后重试接入。" });
        return send(200, await pending);
      }
      catch (error) { return send(400, { error: error.message }); }
    }
    if (changing || protectionChanging) return send(409, { error: "已有配置执行中。" });
    changing = true;
    try {
      const body = await parseBody(req);
      if (req.url === "/browser-cloak") return send(200, await browserCloak.sync(origin, { launch: body.launch === true, force: body.force === true }));
      browserCloak.detach();
      const targets = protection.report().enabled ? ([...environmentRuntime.clients.keys()].length ? [...environmentRuntime.clients.keys()] : ["web"]) : undefined;
      return send(200, req.url.endsWith("/restore") ? await environmentRuntime.restore() : await environmentRuntime.apply(body.policy, origin, targets));
    } catch (error) { return send(400, { error: error.message }); }
    finally { changing = false; }
  }
  // 写入出口目标，供 Claude 网关层读取；只存数据，不修改系统设置。
  if (req.method === "POST" && req.url === "/profile") {
    if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效，请重新打开面板。" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "必须使用 JSON。" });
    try {
      const body = await parseBody(req);
      const target = validTarget(body?.target);
      if (!target) return send(400, { error: "出口目标格式无效。" });
      const profile = { target, updatedAt: new Date().toISOString() };
      await saveProfile(profile);
      return send(200, { profile, gateway: `http://127.0.0.1:3010` });
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: "无效的 JSON。" });
      return send(500, { error: "无法写入出口目标配置。" });
    }
  }
  if (req.method !== "POST" || !["/timezone", "/timezone/restore"].includes(req.url)) return send(404, { error: "未找到此操作。" });
  if (!authenticated(req.headers["x-checkcc-token"])) return send(403, { error: "会话已失效，请重新打开详情。" });
  if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "必须使用 JSON。" });
  if (changing || protectionChanging) return send(409, { error: "已有时区修改正在执行。" });
  changing = true;
  try {
    const body = await parseBody(req);
    const restoring = req.url === "/timezone/restore";
    let target;
    if (restoring) {
      const backup = await readBackup();
      if (!backup) return send(409, { error: "没有可恢复的原始时区。" });
      target = backup.timezone;
    } else {
      if (!body || typeof body.timezone !== "string" || !allowedZones.has(body.timezone)) return send(400, { error: "请选择列表中的有效时区。" });
      target = body.timezone;
    }
    // Pass timezone as data, never interpolate a browser value into PowerShell code.
    const before = await currentZone();
    if (!restoring && !await readBackup()) await saveBackup(before);
    await setZone(target);
    const actual = await currentZone();
    if (actual !== target) throw new Error("系统未返回预期时区，请在系统设置中核对。");
    if (restoring) await rm(backupFile, { force: true });
    return send(200, { timezone: actual, canRestore: Boolean(await readBackup()) });
  } catch (error) {
    if (error instanceof SyntaxError) return send(400, { error: "无效的 JSON 请求。" });
    console.error("[repair] Timezone operation failed:", error.message);
    return send(500, { error: "时区操作失败，系统可能拒绝了权限。请在 Windows 日期和时间设置中核对；若操作中断，可使用恢复原始时区。" });
  } finally { changing = false; }
});
server.requestTimeout = 45000;
server.headersTimeout = 10000;
server.on("error", (error) => { if (error.code !== "EADDRINUSE") console.error(`[repair] ${error.code}: ${error.message}`); });
export async function startRepairHelper(listenPort = port) {
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", resolve); });
    await protection.recover();
    await desktopLauncher.localeProfile.restore();
    initializing = false;
    return { server, url: `http://127.0.0.1:${server.address().port}`, closeRuntime };
  } catch (error) {
    if (error.code !== "EADDRINUSE") {
      if (server.listening && initializing) await new Promise(resolve => server.close(resolve));
      throw error;
    }
    const response = await fetch(`http://127.0.0.1:${listenPort}/session`, { headers: { Origin: "http://localhost:3000", "X-CheckCC-Client": "repair-ui" }, signal: AbortSignal.timeout(3500) });
    const session = await response.json();
    if (!response.ok || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error("本机助手端口被其他服务占用。");
    if (session.environmentScripts !== 1 || session.browserCloak !== 1) throw new Error("3001 端口上的本机助手为旧版本，请退出旧 repair:helper 后重启 npm run dev。");
    assertCurrentHelper(session);
    const url = `http://127.0.0.1:${listenPort}`;
    return { server: null, url, closeRuntime: () => shutdownHelper(url, "http://localhost:3000", session, true) };
  }
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) startRepairHelper().then((helper) => {
  console.log(`EnvGuardCC local repair helper ready at ${helper.url}`);
  if (!helper.server) return;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await new Promise((resolve) => helper.server.close(resolve));
    await helper.closeRuntime();
  };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
