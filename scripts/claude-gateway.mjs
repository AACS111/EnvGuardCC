// Claude API gateway and diagnostics use the same native Node HTTP(S) route.
import http from "node:http";
import { probeLiveGateway, PROBE_SIGNAL_IDS } from "./gateway-message-probe.mjs";
import { proxyInfo } from "./gateway-proxy.mjs";
import { createSimulationRunner } from "./simulation-runner.mjs";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectEdgeTrace, collectNetworkDiagnostics, extractClientClues, transportRequest } from "./gateway-diagnostics.mjs";
import { fetchSubscription, parseSubscription } from "./net-core/subscription.mjs";
import { readExitHistory, recordExit } from "./net-core/exit-history.mjs";
import { userAgentPlatform } from "../src/detection/environment-profile.mjs";
/**
 * 声明面归一化：UA 与 Client Hints 必须自洽。
 * 只修正矛盾，不伪造平台——韩国用户同样使用 Windows，伪造成 macOS 只会与 UA/TLS 指纹冲突。
 * 没有 sec-ch-ua 的客户端不凭空补头：凭空出现的 UA-CH 本身就是指纹。
 */
export function alignClientHints(headers) {
  const userAgent = headers["user-agent"];
  const hints = headers["sec-ch-ua"];
  if (typeof userAgent !== "string" || typeof hints !== "string" || !hints) return headers;
  const platform = userAgentPlatform(userAgent);
  if (platform) {
    const value = platform === "Chrome OS" ? "Chrome OS" : platform;
    headers["sec-ch-ua-platform"] = `"${value}"`;
    headers["sec-ch-ua-mobile"] = platform === "Android" ? "?1" : "?0";
  }
  // 只把「原本与 UA 主版本相同」的品牌改写为新主版本；Not?A_Brand 的版本号保持不变。
  const major = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(userAgent)?.[1];
  const previous = /v="?(\d+)"?/.exec(hints)?.[1];
  if (major && previous && major !== previous) headers["sec-ch-ua"] = hints.replaceAll(`v="${previous}"`, `v="${major}"`);
  return headers;
}

/** 诊断用：一眼看出声明面是否自洽（不参与评分，只给事实）。 */
export function headerConsistency(headers) {
  const userAgent = headers["user-agent"];
  const hints = headers["sec-ch-ua"];
  if (typeof userAgent !== "string") return null;
  const platform = userAgentPlatform(userAgent);
  const hintPlatform = typeof headers["sec-ch-ua-platform"] === "string" ? headers["sec-ch-ua-platform"].replace(/"/g, "") : null;
  const major = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(userAgent)?.[1] ?? null;
  const hintMajor = typeof hints === "string" ? /v="?(\d+)"?/.exec(hints)?.[1] ?? null : null;
  return {
    platform, hintPlatform, major, hintMajor,
    aligned: (!platform || !hintPlatform || platform === hintPlatform) && (!major || !hintMajor || major === hintMajor),
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProfile = path.join(process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".check-cc-local"), "region-profile.json");
const defaultStateDir = process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".check-cc-local");
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const DROP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "accept-language", "x-checkcc-simulation", "x-checkcc-client", "x-checkcc-token", "x-checkcc-target-locale",
]);

export function languageHeader(language) {
  const base = language.split("-")[0].toLowerCase();
  if (base === "en") return `${language === "en" ? "en-US" : language},en;q=0.9`;
  return language === base ? `${base},en;q=0.5` : `${language},${base};q=0.9,en;q=0.5`;
}

// 真实上游只允许标准头。任何 x-checkcc-* 都是本地诊断标记，上行即成为可识别的客户端指纹。
export function wireHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !key.toLowerCase().startsWith("x-checkcc-")));
}

export function buildHeaders(requestHeaders, profile, cloakEnabled = true) {
  const headers = {};
  const connectionTokens = new Set(String(requestHeaders.connection ?? "").toLowerCase().split(",").map((key) => key.trim()));
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!DROP.has(key.toLowerCase()) && !connectionTokens.has(key.toLowerCase())) headers[key] = value;
  }
  // 关闭模拟保护时，语言/区域声明头按客户端原样转发。
  if (profile && cloakEnabled) {
    headers["accept-language"] = languageHeader(profile.language);
    headers["x-checkcc-target-locale"] = profile.locale;
    // 语言改了而 UA/UA-CH 仍互相矛盾，等于把矛盾交给服务端去发现。
    alignClientHints(headers);
  } else {
    if (requestHeaders["accept-language"]) headers["accept-language"] = requestHeaders["accept-language"];
    if (requestHeaders["x-checkcc-target-locale"]) headers["x-checkcc-target-locale"] = requestHeaders["x-checkcc-target-locale"];
  }
  return headers;
}

// A strict allowlist prevents credentials and arbitrary profile fields entering reports.
export function safeHeaders(headers) {
  return Object.fromEntries(["accept-language", "x-checkcc-target-locale", "user-agent", "anthropic-version", "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile"]
    .filter((key) => typeof headers[key] === "string")
    .map((key) => [key, headers[key].slice(0, 512)]));
}

// 模拟保护默认开启；开启时才把语言/区域声明改写为出口目标值，关闭时原样转发。
const cloaked = { enabled: true, updatedAt: null };

export function cloakState() {
  return { enabled: cloaked.enabled, updatedAt: cloaked.updatedAt };
}

export function setCloak(enabled) {
  if (typeof enabled !== "boolean") throw new Error("INVALID_CLOAK_STATE");
  cloaked.enabled = enabled;
  cloaked.updatedAt = new Date().toISOString();
  return cloakState();
}

async function loadProfile(filename) {
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    const target = value?.target;
    if (!target || typeof target.language !== "string" || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(target.language)) throw new Error("INVALID_PROFILE");
    if (typeof target.locale !== "string" || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(target.locale)) throw new Error("INVALID_PROFILE");
    const short = (field) => typeof field === "string" ? field.slice(0, 128) : null;
    return {
      language: target.language, locale: target.locale, timezone: short(target.timezone),
      countryName: short(target.countryName), city: short(target.city), updatedAt: short(value.updatedAt),
    };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 老运行时没有 collectDelays 时的兼容路径：并行测速，不让一个死节点拖死整批。 */
async function parallelDelay(netCore, names) {
  const delays = {};
  await Promise.all(names.map(async (name) => {
    try { delays[name] = await netCore.delay(name); }
    catch { delays[name] = null; }
  }));
  return delays;
}

function sendJson(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createGateway({ upstreamBase = "https://api.anthropic.com", profileFile = defaultProfile, stateDir = defaultStateDir, collect = collectNetworkDiagnostics, cacheMs = 15000, netCore = null } = {}) {
  const upstream = new URL(upstreamBase);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error("CHECKCC_UPSTREAM 必须是无凭证、无查询参数的 HTTP(S) 地址。");
  const probeTargets = new Map();
  // 内核状态 + 出口历史：两者都不依赖网络探测，可以随只读接口一起返回。
  const kernelPayload = async () => {
    const report = await Promise.resolve(netCore?.report()).catch((error) => ({ state: "unavailable", reason: error.message }));
    const exitHistory = await readExitHistory(stateDir).catch(() => null);
    return { netCore: report, exitHistory };
  };
  const simulation = createSimulationRunner({ messageProbe: () => probeLiveGateway(server, probeTargets) });
  let updatingOptimization = false;
  let rewrites = 0;
  let lastRequest = null;
  let lastFailure = null;
  let lastDiagnostics = null;
  let lastClues = null;
  let inFlight = null;
  const networkDiagnostics = async () => {
    if (lastDiagnostics && Date.now() - lastDiagnostics.at < cacheMs) return lastDiagnostics.value;
    if (!inFlight) inFlight = collect(upstream).then((value) => {
      lastDiagnostics = { at: Date.now(), value }; return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      const origin = request.headers.origin;
      if (request.socket.remoteAddress !== "127.0.0.1" || !/^127\.0\.0\.1:\d+$/.test(host ?? "") || (origin && !localOrigin.test(origin))) return sendJson(response, 403, { error: "仅允许本机 EnvGuardCC 页面或客户端访问。" });
      const rawPath = request.url || "/";
      if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\")) return sendJson(response, 400, { error: "无效的上游路径。" });
      const pathname = rawPath.split("?")[0];
      if (!pathname.startsWith("/__checkcc/")) {
        const connection = netCore?.connectionState?.();
        if (connection?.strictEnabled && connection.state !== "verified") return sendJson(response, 503, { error: "严格模式暂停连接，等待网络重新验证。" });
      }

      if (pathname.startsWith("/__checkcc/")) {
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin);
          response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
          if (!["GET", "POST"].includes(request.headers["access-control-request-method"])) return sendJson(response, 405, { error: "诊断接口仅允许 GET/POST。" });
          response.setHeader("Access-Control-Allow-Methods", "GET, POST");
          response.setHeader("Access-Control-Allow-Headers", "X-CheckCC-Client, Content-Type");
          response.setHeader("Access-Control-Allow-Private-Network", "true");
          response.writeHead(204); return response.end();
        }
        if (request.headers["x-checkcc-client"] !== "gateway-ui") return sendJson(response, 403, { error: "缺少诊断客户端标识。" });
        if (!["/__checkcc/status", "/__checkcc/diagnostics", "/__checkcc/cloak", "/__checkcc/simulation", "/__checkcc/message-probe", "/__checkcc/browser-probe", "/__checkcc/net-core", "/__checkcc/net-core/host", "/__checkcc/net-core/import", "/__checkcc/net-core/sources", "/__checkcc/net-core/refresh", "/__checkcc/net-core/delay", "/__checkcc/net-core/exits", "/__checkcc/net-core/mode", "/__checkcc/net-core/network", "/__checkcc/net-core/verify-domain", "/__checkcc/net-core/local-proxies", "/__checkcc/net-core/connections"].includes(pathname)) return sendJson(response, 404, { error: "未知诊断接口。" });
        if (pathname === "/__checkcc/net-core/connections") {
          if (!["GET", "POST"].includes(request.method)) return sendJson(response, 405, { error: "传输记录仅允许 GET/POST。" });
          const log = netCore?.connectionLog;
          if (request.method === "GET") {
            const params = new URL(rawPath, "http://127.0.0.1").searchParams;
            if (params.get("view") === "settings") return sendJson(response, 200, { ok: true, ...(log?.settings?.() ?? { scope: "all" }) });
            const host = params.get("host") ?? "";
            for (const key of ["claude", "viaExit"]) {
              if (params.has(key) && !["true", "false"].includes(params.get(key))) return sendJson(response, 400, { error: "连接筛选参数无效。" });
            }
            for (const key of ["offset", "limit"]) {
              if (params.has(key) && !/^\d{1,9}$/.test(params.get(key))) return sendJson(response, 400, { error: "分页参数无效。" });
            }
            if (host.length > 253) return sendJson(response, 400, { error: "主机筛选过长。" });
            if (params.has("kind") && !["all", "connection", "request"].includes(params.get("kind"))) return sendJson(response, 400, { error: "记录类型无效。" });
            if (params.has("route") && !["all", "proxied", "direct", "blocked", "unknown"].includes(params.get("route"))) return sendJson(response, 400, { error: "连接路径无效。" });
            if (params.has("state") && !["all", "active", "ended"].includes(params.get("state"))) return sendJson(response, 400, { error: "连接状态无效。" });
            if (params.has("at") && (!Number.isFinite(Date.parse(params.get("at"))) || Date.parse(params.get("at")) > Date.now() + 5000)) return sendJson(response, 400, { error: "回放时间无效。" });
            if (params.has("detailId") && !/^[\w-]{1,128}$/.test(params.get("detailId"))) return sendJson(response, 400, { error: "记录标识无效。" });
            if (params.has("format") && !["json", "csv"].includes(params.get("format"))) return sendJson(response, 400, { error: "导出格式无效。" });
            if (!log && params.has("format")) return sendJson(response, 503, { ok: false, error: "当前后台不支持传输记录导出。" });
            if (!log) return sendJson(response, 200, { ok: true, available: false, storageError: false, retentionHours: 48, stats: { active: 0, ended: 0, total: 0 }, total: 0, offset: 0, limit: 50, items: [], recent: [] });
            try {
              const query = { host, claude: params.get("claude") === "true", viaExit: params.has("viaExit") ? params.get("viaExit") === "true" : null, offset: Number(params.get("offset") || 0), limit: Number(params.get("limit") || 50), kind: params.get("kind") ?? "all", route: params.get("route") ?? "all", state: params.get("state") ?? "all", at: params.get("at"), detailId: params.get("detailId") };
              if (params.has("format")) {
                const format = params.get("format");
                const body = await log.export(query, format);
                response.writeHead(200, { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="envguardcc-transfer-log.${format}"`, "Cache-Control": "no-store" });
                return response.end(body);
              }
              return sendJson(response, 200, { ok: true, ...await log.list(query) });
            } catch { return sendJson(response, 500, { ok: false, error: "无法读取本机传输记录。" }); }
          }
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 256) return sendJson(response, 413, { error: "请求过大。" });
          }
          let value;
          try { value = JSON.parse(body); } catch { return sendJson(response, 400, { error: "无效的清空请求。" }); }
          if (!["clear", "settings"].includes(value?.action) || (value.action === "settings" && !["all", "claude"].includes(value.scope))) return sendJson(response, 400, { error: "传输记录操作无效。" });
          if (!log) return sendJson(response, 503, { ok: false, error: "当前后台不支持传输记录。" });
          if (value.action === "settings") {
            try { return sendJson(response, 200, { ok: true, ...await log.setScope(value.scope) }); }
            catch { return sendJson(response, 500, { ok: false, error: "无法保存记录范围。" }); }
          }
          try { await log.clear(); return sendJson(response, 200, { ok: true, cleared: true, ...await log.list({ limit: 3 }) }); }
          catch { return sendJson(response, 500, { ok: false, error: "无法清空本机传输记录。" }); }
        }
        // 本地代理扫描：列出本机可借用的 FlClash / Clash Verge 等端口（只读，不改它们的设置）。
        if (pathname === "/__checkcc/net-core/local-proxies") {
          if (request.method !== "GET") return sendJson(response, 405, { error: "扫描仅允许 GET。" });
          try {
            const { scanLocalProxies, describeLocalProxies } = await import("./net-core/local-proxy.mjs");
            const items = await scanLocalProxies();
            return sendJson(response, 200, { ok: true, items, summary: describeLocalProxies(items) });
          } catch (error) { return sendJson(response, 500, { ok: false, error: error.message }); }
        }
        // 导入节点：链接 / 粘贴内容 / 手工结构。解析失败不覆盖已有配置。
        if (pathname === "/__checkcc/net-core/import") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "导入仅允许 POST。" });
          if (!netCore || typeof netCore.importNodes !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          let importBody = "";
          for await (const chunk of request) {
            importBody += chunk;
            if (Buffer.byteLength(importBody) > 4 * 1024 * 1024) return sendJson(response, 413, { error: "导入内容过大。" });
          }
          let value;
          try { value = JSON.parse(importBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          let parsed;
          try {
            if (value?.mode === "url") {
              // 先把这个订阅域名设为直连：机场普遍按来源 IP 放行，走隧道出去会被 403（实测）。
              if (typeof netCore?.allowDirectSubscription === "function") {
                await netCore.allowDirectSubscription(value.url).catch(() => {});
              }
              parsed = parseSubscription(await fetchSubscription(value.url));
            }
            else if (value?.mode === "content") parsed = parseSubscription(value.content);
            else if (value?.mode === "manual") parsed = { proxies: value.proxies };
            else if (value?.mode === "local-proxy") {
              // 把本机已有的代理客户端当出口节点用：只指向它的环回端口，不读它的配置。
              const port = Number(value.port);
              if (!Number.isInteger(port) || port < 1 || port > 65535) return sendJson(response, 400, { error: "本地代理端口无效。" });
              const type = value.protocol === "socks5" ? "socks5" : "http";
              const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : `本地代理 ${port}`;
              parsed = { proxies: [{ name, type, server: "127.0.0.1", port }] };
            }
            else return sendJson(response, 400, { error: "未知的导入方式。" });
          } catch (error) { return sendJson(response, 400, { error: error.message }); }
          try {
            const result = await netCore.importNodes(parsed.proxies, {
              selected: value?.selected,
              // 本地代理是额外出口：追加而不是替换，不能把已有订阅节点抹掉。
              append: value?.mode === "local-proxy",
              // 订阅自带的 proxy-server-nameserver 决定节点域名能否解析，必须一并落盘。
              proxyServerDns: Array.isArray(parsed.proxyServerDns) ? parsed.proxyServerDns : null,
              source: value?.mode === "url" ? { mode: "url", url: value.url, updatedAt: new Date().toISOString() } : null,
              // 编辑已有供应商：只改这一条，不新建重复项。
              sourceId: typeof value?.sourceId === "string" && value.sourceId ? value.sourceId : null,
              sourceName: typeof value?.name === "string" && value.name.trim() ? value.name.trim() : null,
            });
            return sendJson(response, 200, { ok: true, ...result, ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { error: error.message }); }
        }
        // 供应商（配置来源）：一条来源 = 一份可切换的节点快照。
        if (pathname === "/__checkcc/net-core/sources") {
          if (!netCore || typeof netCore.sources !== "function") return sendJson(response, 200, { ok: false, sources: [], reason: "本次启动未接入网络内核。" });
          if (request.method === "GET") return sendJson(response, 200, { ok: true, sources: netCore.sources(), ...await kernelPayload() });
          if (request.method !== "POST") return sendJson(response, 405, { error: "配置来源仅允许 GET/POST。" });
          let sourceBody = "";
          for await (const chunk of request) {
            sourceBody += chunk;
            if (Buffer.byteLength(sourceBody) > 8192) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(sourceBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          const id = typeof value?.id === "string" ? value.id : "";
          if (!id) return sendJson(response, 400, { error: "请提供要操作的配置。" });
          try {
            const { action } = value;
            let result;
            if (action === "activate") result = await netCore.activateSource(id);
            else if (action === "delete") result = await netCore.deleteSource(id);
            else if (action === "rename") result = await netCore.renameSource(id, value?.name);
            else if (action === "refresh") result = await netCore.refresh({ force: true, sourceId: id });
            else return sendJson(response, 400, { error: "未知的配置操作。" });
            return sendJson(response, 200, { ok: true, ...result, sources: netCore.sources(), ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { ok: false, reason: error.message, ...await kernelPayload() }); }
        }
        // 解析测试：用内核真实解析一次，判断这份声明到底够不够。
        if (pathname === "/__checkcc/net-core/verify-domain") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "解析测试仅允许 POST。" });
          if (!netCore || typeof netCore.verifyDomain !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          let verifyBody = "";
          for await (const chunk of request) {
            verifyBody += chunk;
            if (Buffer.byteLength(verifyBody) > 64 * 1024) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(verifyBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) return sendJson(response, 400, { error: "请提供 config 对象。" });
          try {
            const verified = await netCore.verifyDomain(value.config, value.name);
            return sendJson(response, 200, { ...await netCore.network(), ...verified, ok: true, ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { ok: false, reason: error.message, ...await kernelPayload() }); }
        }
        // 用户网络声明（内网域名 / 豁免 IP / DNS / 网卡）：保存前试算，写盘后可选重启。
        if (pathname === "/__checkcc/net-core/network") {
          if (!netCore || typeof netCore.network !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          if (request.method === "GET") return sendJson(response, 200, { ...await netCore.network(), ok: true });
          if (request.method !== "POST") return sendJson(response, 405, { error: "网络豁免配置仅允许 GET/POST。" });
          let networkBody = "";
          for await (const chunk of request) {
            networkBody += chunk;
            if (Buffer.byteLength(networkBody) > 64 * 1024) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(networkBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) return sendJson(response, 400, { error: "请提供 config 对象。" });
          try {
            const result = await netCore.saveNetwork(value.config, { restart: value.restart === true });
            return sendJson(response, 200, { ok: true, ...result, ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { ok: false, reason: error.message, ...await kernelPayload() }); }
        }
        // 出站模式：rule / global / direct。切换后由运行时重建配置。
        if (pathname === "/__checkcc/net-core/mode") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "出站模式仅允许 POST。" });
          if (!netCore || typeof netCore.setMode !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          let modeBody = "";
          for await (const chunk of request) {
            modeBody += chunk;
            if (Buffer.byteLength(modeBody) > 4096) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(modeBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          try {
            const result = await netCore.setMode(value?.mode);
            return sendJson(response, 200, { ok: true, ...result, ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { ok: false, reason: error.message, ...await kernelPayload() }); }
        }
        // 节点延迟：逐个读取内核的延迟测试结果；失败的节点返回 null，不编造数字。
        if (pathname === "/__checkcc/net-core/delay") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "测速仅允许 POST。" });
          if (!netCore || typeof netCore.delay !== "function") return sendJson(response, 200, { ok: false, delays: {}, reason: "本次启动未接入网络内核。" });
          let delayBody = "";
          for await (const chunk of request) {
            delayBody += chunk;
            if (Buffer.byteLength(delayBody) > 8192) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(delayBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          const names = Array.isArray(value?.names) ? value.names.filter((name) => typeof name === "string" && name && name.length <= 128).slice(0, 50) : [];
          if (!names.length) return sendJson(response, 400, { error: "请提供要测速的节点名称。" });
          // 并行测速：串行会让 25 个节点拖到两分钟，界面一直卡在「测速中…」。
          const delays = typeof netCore.collectDelays === "function"
            ? await netCore.collectDelays(names, { force: value?.force === true })
            : await parallelDelay(netCore, names);
          return sendJson(response, 200, { ok: true, delays, ...await kernelPayload() });
        }
        // 逐节点实测出口国家：节点名不可信，只有真的从该节点出去问一次才知道。
        if (pathname === "/__checkcc/net-core/exits") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "出口检测仅允许 POST。" });
          if (!netCore || typeof netCore.probeNodeExits !== "function") return sendJson(response, 200, { ok: false, exits: {}, reason: "本次启动未支持出口检测。" });
          let body = "";
          for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) return sendJson(response, 413, { error: "请求体过大。" }); }
          let value;
          try { value = JSON.parse(body || "{}"); } catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          const names = Array.isArray(value?.names) ? value.names.filter((name) => typeof name === "string" && name && name.length <= 128).slice(0, 50) : [];
          if (!names.length) return sendJson(response, 400, { error: "请提供要检测的节点名称。" });
          try {
            const exits = await netCore.probeNodeExits(names);
            const probed = Object.values(exits ?? {});
            // 全部节点都没拿到 IP 时明确说失败：只显示「未测得」会让人分不清是节点问题还是程序问题。
            const reason = probed.length && probed.every((entry) => !entry?.ip) ? "所有节点都未返回出口 IP；请检查节点连通性或稍后重试。" : undefined;
            return sendJson(response, 200, { ok: !reason, exits, ...(reason ? { reason } : {}), ...await kernelPayload() });
          } catch (error) { return sendJson(response, 200, { ok: false, exits: {}, reason: error.message }); }
        }
        // 订阅刷新：手动触发或按间隔自动触发；失败不影响现有节点。
        if (pathname === "/__checkcc/net-core/refresh") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "订阅刷新仅允许 POST。" });
          if (!netCore || typeof netCore.refresh !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          let refreshBody = "";
          for await (const chunk of request) {
            refreshBody += chunk;
            if (Buffer.byteLength(refreshBody) > 4096) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value = {};
          try { value = JSON.parse(refreshBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          try {
            const result = await netCore.refresh({ force: value?.force === true });
            return sendJson(response, 200, { ok: true, ...result, ...await kernelPayload() });
          } catch (error) { return sendJson(response, 400, { ok: false, reason: error.message, ...await kernelPayload() }); }
        }
        // 特权宿主安装：只接受固定动作，路径来自服务端；macOS 会弹系统授权窗口。
        if (pathname === "/__checkcc/net-core/host") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "宿主安装仅允许 POST。" });
          if (!netCore || typeof netCore.installHost !== "function") return sendJson(response, 200, { ok: false, reason: "本次启动未接入网络内核。" });
          let hostBody = "";
          for await (const chunk of request) {
            hostBody += chunk;
            if (Buffer.byteLength(hostBody) > 4096) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let hostValue;
          try { hostValue = JSON.parse(hostBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          if (hostValue?.action !== "install") return sendJson(response, 400, { error: "未知的宿主操作。" });
          try {
            const result = await netCore.installHost();
            return sendJson(response, 200, { ok: true, ...result, ...await kernelPayload() });
          } catch (error) {
            return sendJson(response, 200, { ok: false, reason: error.message, ...await kernelPayload() });
          }
        }
        // 内核操作：只允许白名单动作，不暴露通用执行能力。
        if (pathname === "/__checkcc/net-core") {
          if (!netCore) return sendJson(response, 200, { ok: false, netCore: { state: "disabled", reason: "本次启动未接入网络内核。" } });
          // GET 只读状态（不触发网络探测）；POST 才执行动作。
          if (request.method === "GET") return sendJson(response, 200, await kernelPayload());
          if (request.method !== "POST") return sendJson(response, 405, { error: "内核操作仅允许 GET/POST。" });
          let kernelBody = "";
          for await (const chunk of request) {
            kernelBody += chunk;
            if (Buffer.byteLength(kernelBody) > 4096) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let kernelValue;
          try { kernelValue = JSON.parse(kernelBody || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          const action = kernelValue?.action;
          if (!["start", "stop", "restart", "select", "tunnel", "strict", "unlock-region"].includes(action)) return sendJson(response, 400, { error: "未知的内核操作。" });
          if (["tunnel", "strict"].includes(action) && typeof kernelValue?.enabled !== "boolean") return sendJson(response, 400, { error: "网络开关必须是布尔值。" });
          let node = null;
          if (action === "select") {
            node = kernelValue?.node;
            if (typeof node !== "string" || !node || node.length > 128) return sendJson(response, 400, { error: "节点名称无效。" });
          }
          let ok = true;
          let reason = null;
          try {
            if (action === "start") ok = await netCore.start();
            else if (action === "strict") {
              if (typeof netCore.setStrictMode !== "function") throw new Error("当前后台不支持系统断流保护，请更新应用。");
              await netCore.setStrictMode(kernelValue.enabled);
            }
            else if (action === "unlock-region") {
              if (typeof netCore.unlockRegion !== "function") throw new Error("当前后台不支持区域锁定解除，请更新应用。");
              await netCore.unlockRegion();
            }
            else if (action === "tunnel") {
              // 关闭保护只退 TUN，内核保持运行。
              if (typeof netCore.setTunnel !== "function") { ok = false; reason = "本次启动未支持单独的 TUN 开关。"; }
              else await netCore.setTunnel(kernelValue.enabled);
            }
            else if (action === "stop") await netCore.stop();
            else if (action === "restart") { await netCore.stop(); ok = await netCore.start(); }
            else ok = await netCore.select(node);
          } catch (error) { ok = false; reason = error.message; }
          const payload = await kernelPayload();
          // start() 用返回值表达失败，不抛异常：把内核报告里的真实原因带回接口，
          // 否则界面只能显示「内核操作未生效」这种没有信息量的话。
          if (!ok && !reason) reason = payload.netCore?.reason ?? null;
          return sendJson(response, 200, { action, ok, reason, ...payload });
        }
        if (pathname === "/__checkcc/browser-probe") {
          if (request.method !== "GET") return sendJson(response, 405, { error: "浏览器接收端仅允许 GET。" });
          return sendJson(response, 200, { version: 1, kind: "browser-headers-probe", receivedLanguage: String(request.headers["accept-language"] ?? "").slice(0, 512), receivedUserAgent: String(request.headers["user-agent"] ?? "").slice(0, 512), sampledAt: new Date().toISOString() });
        }
        if (pathname === "/__checkcc/message-probe") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "单项模拟只允许 POST。" });
          const signalId = new URL(rawPath, "http://localhost").searchParams.get("signal");
          if (!PROBE_SIGNAL_IDS.includes(signalId)) return sendJson(response, 400, { error: "该项目不是模拟测试点。" });
          const profile = await loadProfile(profileFile);
          const cloak = cloakState();
          if (!profile || !cloak.enabled) return sendJson(response, 409, { error: "请先配置并开启网关。" });
          const messageProbe = await probeLiveGateway(server, probeTargets);
          const expectedLanguage = profile.language === "en" ? "en-US" : profile.language;
          const passed = messageProbe.status === 200 && messageProbe.bodyUnchanged && messageProbe.headersIntegrity && messageProbe.receivedLanguage.split(",")[0] === expectedLanguage && messageProbe.receivedLocale === profile.locale;
          const testedIds = new URL(rawPath, "http://localhost").searchParams.get("related") === "1" ? PROBE_SIGNAL_IDS : [...new Set([signalId, "language"])];
          return sendJson(response, 200, { version: 1, kind: "local-simulation-only", state: passed ? "passed" : "failed", running: false, runId: randomUUID(), profileUpdatedAt: profile.updatedAt, cloakUpdatedAt: cloak.updatedAt, target: profile, messageProbe, scenarios: [], signalResults: Object.fromEntries(testedIds.map((id) => [id, { state: passed ? "passed" : "failed", completed: 1, total: 1, failed: passed ? 0 : 1 }])) });
        }
        if (pathname === "/__checkcc/simulation") {
          if (!["GET", "POST"].includes(request.method)) return sendJson(response, 405, { error: "自检接口仅支持 GET/POST。" });
          let profile = null;
          try { profile = await loadProfile(profileFile); } catch { return sendJson(response, 409, { error: "出口配置无效，请重新配置。" }); }
          const context = { profile, cloak: cloakState() };
          if (request.method === "GET") return sendJson(response, 200, simulation.snapshot(context));
          if (!profile || !context.cloak.enabled) return sendJson(response, 409, { error: "请先开启优化，再执行本地自检。" });
          return sendJson(response, 202, await simulation.start(context));
        }
        // 模拟保护开关：只控制语言/区域声明头的改写，不改本机系统与网络路径。
        if (pathname === "/__checkcc/cloak") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "模拟保护开关仅允许 POST。" });
          if (updatingOptimization) return sendJson(response, 409, { error: "优化配置正在更新，请稍后重试。" });
          updatingOptimization = true;
          try {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 4096) return sendJson(response, 413, { error: "请求体过大。" });
          }
          let value;
          try { value = JSON.parse(body || "{}"); }
          catch { return sendJson(response, 400, { error: "无效的 JSON。" }); }
          if (typeof value?.enabled !== "boolean") return sendJson(response, 400, { error: "enabled 必须是布尔值。" });
          if (value.enabled && value.target !== undefined) {
            const target = value.target;
            const validLocale = (field) => typeof field === "string" && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(field);
            if (!target || !validLocale(target.language) || !validLocale(target.locale)) return sendJson(response, 400, { error: "出口语言或区域格式无效。" });
            const short = (field) => typeof field === "string" ? field.slice(0, 128) : null;
            const profile = { target: { language: target.language, locale: target.locale, timezone: short(target.timezone), countryName: short(target.countryName), city: short(target.city) }, updatedAt: new Date().toISOString() };
            await mkdir(path.dirname(profileFile), { recursive: true });
            const temporary = `${profileFile}.${randomUUID()}.tmp`;
            try {
              await writeFile(temporary, JSON.stringify(profile, null, 2), { mode: 0o600 });
              await rename(temporary, profileFile);
            } finally { await rm(temporary, { force: true }); }
          }
          let profile = null;
          try { profile = await loadProfile(profileFile); }
          catch { if (value.enabled) return sendJson(response, 409, { error: "出口配置无效，请重新识别出口后开启。" }); }
          if (value.enabled && !profile) return sendJson(response, 409, { error: "尚未配置出口地区，请重新识别出口后开启。" });
          return sendJson(response, 200, { cloak: { ...setCloak(value.enabled), target: profile } });
          } finally { updatingOptimization = false; }
        }
        if (request.method !== "GET") return sendJson(response, 405, { error: "诊断接口仅允许 GET/POST。" });
        let profile = null;
        let profileError = null;
        try { profile = await loadProfile(profileFile); } catch { profileError = "INVALID_PROFILE"; }
        const report = {
          version: 1, upstream: upstream.href, platform: process.platform, profile, profileError, rewrites,
          transport: proxyInfo(upstream).mode === "direct" ? "node-native-direct" : "node-native-proxy", proxy: proxyInfo(upstream), proxyEnvironmentDetected: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || process.env.https_proxy || process.env.http_proxy || process.env.all_proxy),
          previewHeaders: safeHeaders(buildHeaders({}, profile, cloaked.enabled)), lastRequest, lastFailure, clues: lastClues,
          // 声明面自洽情况：只报事实，不参与打分；矛盾时用户能直接看见是哪一项。
          headerAlignment: lastRequest ? headerConsistency(lastRequest.headers) : null,
          cloak: { ...cloakState(), enabled: cloaked.enabled && Boolean(profile), target: profile },
        };
        if (pathname === "/__checkcc/diagnostics") {
          const signalId = new URL(rawPath, "http://localhost").searchParams.get("signal");
          if (signalId && !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(signalId)) return sendJson(response, 400, { error: "无效检测项。" });
          Object.assign(report, signalId ? await collect(upstream, { signalId }) : await networkDiagnostics());
          // 出口 IP 历史：只记录观测，不参与打分；变化次数由界面展示。
          const exitIp = report.exit?.primary?.ip;
          report.exitHistory = exitIp
            ? await recordExit(stateDir, exitIp).catch(() => null)
            : await readExitHistory(stateDir).catch(() => null);
          if (!signalId || ["edgeCountry", "edgeCity", "edgeColo"].includes(signalId)) {
            report.edge = await collectEdgeTrace();
            report.testedSignals = [...(report.testedSignals ?? []), "edgeCountry", "edgeCity", "edgeColo"];
          }
          // 内核状态只在诊断接口返回；未接内核时明确说“未启用”，不用空对象冒充可用。
          if (netCore) {
            try { report.netCore = await netCore.report(); }
            catch (error) { report.netCore = { state: "unavailable", reason: error.message }; }
          } else {
            report.netCore = { state: "disabled", reason: "本次启动未接入网络内核。" };
          }
        }
        return sendJson(response, 200, report);
      }

      const probeToken = request.headers["x-checkcc-simulation"];
      const probeTarget = probeTargets.get(probeToken);
      const isSimulation = Boolean(probeTarget && request.method === "POST" && rawPath === "/v1/messages");
      if (probeToken && !isSimulation) return sendJson(response, 403, { error: "无效的本地模拟令牌。" });
      if (isSimulation) probeTargets.delete(probeToken);
      const forwardingUpstream = probeTarget ?? upstream;
      let profile;
      try { profile = await loadProfile(profileFile); }
      catch { return sendJson(response, 503, { error: "出口目标配置无效，请重新保存网关配置。" }); }
      const target = new URL(forwardingUpstream.href.replace(/\/$/, "") + rawPath);
      // Fixed upstream: the request URL cannot select a different destination.
      if (target.origin !== forwardingUpstream.origin) return sendJson(response, 400, { error: "上游地址不匹配。" });
      const headers = buildHeaders(request.headers, profile, cloaked.enabled);
      // 本地模拟接收端需要 x-checkcc-target-locale 来验证区域改写确实生效；真实上游不需要且不能收到。
      const outbound = isSimulation ? headers : wireHeaders(headers);
      const isClaudeRequest = !isSimulation && request.method === "POST" && /\/v1\/messages\/?$/.test(target.pathname);
      const started = Date.now();
      const record = {
        startedAt: new Date().toISOString(),
        // headers 是真实上行头；intentHeaders 是改写意图（含区域标记），仅供本地诊断，从未上行。
        headers: safeHeaders(outbound), intentHeaders: safeHeaders(headers),
        // 改写前的客户端原始声明头，用于对比模拟保护是否真的生效。
        originalHeaders: safeHeaders(request.headers),
        method: request.method, endpoint: target.pathname.startsWith("/v1/") ? target.pathname.split("/").slice(0, 3).join("/") : "other",
        profileUpdatedAt: profile?.updatedAt ?? null, status: null, elapsedMs: null, tls: null,
      };
      // 请求日志仅来自此 HTTP 转发链；不解密 TUN 内的其他 HTTPS，也不保存 URL/query/正文。
      const requestLog = !isSimulation ? netCore?.connectionLog : null;
      const requestId = await requestLog?.beginRequest?.({ method: request.method, endpoint: target.pathname, host: target.hostname, port: Number(target.port || (target.protocol === "https:" ? 443 : 80)) }).catch(() => null);
      let requestFinished = false, uploaded = 0, downloaded = 0, requestError = null;
      let lastProgress = 0;
      const progress = (force = false) => {
        if (!requestId || requestFinished || (!force && Date.now() - lastProgress < 1000)) return;
        lastProgress = Date.now();
        void requestLog.updateRequest?.(requestId, { status: record.status, upload: uploaded, download: downloaded }).catch(() => {});
      };
      const finishRequest = () => {
        if (!requestId || requestFinished) return;
        requestFinished = true;
        void requestLog.finishRequest(requestId, { status: record.status, upload: uploaded, download: downloaded, error: requestError }).catch(() => {});
      };
      if (requestId) {
        request.on("data", chunk => { uploaded += chunk.length; progress(); });
        response.on("finish", finishRequest);
        response.on("close", () => { if (!response.writableFinished && !requestError) requestError = "CLIENT_ABORTED"; finishRequest(); });
      }
      if (!isSimulation && profile && cloaked.enabled) rewrites += 1;
      const proxy = transportRequest(target, { method: request.method, headers: outbound, signal: AbortSignal.timeout(120000) }, (upstreamResponse) => {
        record.status = upstreamResponse.statusCode ?? null;
        progress(true);
        if (requestId) upstreamResponse.on("data", chunk => { downloaded += chunk.length; progress(); });
        record.elapsedMs = Date.now() - started;
        record.tls = target.protocol === "https:" ? { authorized: upstreamResponse.socket.authorized === true, protocol: upstreamResponse.socket.getProtocol?.() ?? null } : null;
        if (isClaudeRequest) { lastRequest = record; lastFailure = null; lastClues = extractClientClues(request.headers); }
        const responseHeaders = { ...upstreamResponse.headers };
        const hopHeaders = String(responseHeaders.connection ?? "").toLowerCase().split(",").map((key) => key.trim());
        for (const key of ["transfer-encoding", "connection", "keep-alive", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", ...hopHeaders]) delete responseHeaders[key];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.on("error", () => { requestError = "STREAM_ERROR"; response.destroy(); });
        upstreamResponse.pipe(response);
      });
      proxy.on("error", (error) => {
        requestError = "UPSTREAM_ERROR";
        if (isClaudeRequest) lastFailure = { at: new Date().toISOString(), error: error.code ?? "UPSTREAM_ERROR" };
        if (!response.headersSent) sendJson(response, 502, { error: `网关无法连接上游：${error.code ?? "UPSTREAM_ERROR"}` });
        else response.destroy();
      });
      request.pipe(proxy);
      request.on("aborted", () => { requestError = "CLIENT_ABORTED"; proxy.destroy(); finishRequest(); });
      response.on("close", () => { if (!response.writableEnded) proxy.destroy(); });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "网关诊断或转发失败，请稍后重试。" });
      else response.destroy();
    }
  });
  server.on("close", () => simulation.dispose());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CHECKCC_GATEWAY_PORT || 3010);
  const upstreamBase = process.env.CHECKCC_UPSTREAM || "https://api.anthropic.com";
  const server = createGateway({ upstreamBase });
  server.on("error", (error) => { process.stderr.write(`[gateway] ${error.code ?? error.message}\n`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`[gateway] http://127.0.0.1:${port} → ${upstreamBase}\n[gateway] Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\n`);
  });
}
