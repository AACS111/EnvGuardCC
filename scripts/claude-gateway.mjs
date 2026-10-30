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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProfile = path.join(process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".check-cc-local"), "region-profile.json");
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
  } else {
    if (requestHeaders["accept-language"]) headers["accept-language"] = requestHeaders["accept-language"];
    if (requestHeaders["x-checkcc-target-locale"]) headers["x-checkcc-target-locale"] = requestHeaders["x-checkcc-target-locale"];
  }
  return headers;
}

// A strict allowlist prevents credentials and arbitrary profile fields entering reports.
export function safeHeaders(headers) {
  return Object.fromEntries(["accept-language", "x-checkcc-target-locale", "user-agent", "anthropic-version"]
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

function sendJson(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createGateway({ upstreamBase = "https://api.anthropic.com", profileFile = defaultProfile, collect = collectNetworkDiagnostics, cacheMs = 15000 } = {}) {
  const upstream = new URL(upstreamBase);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error("CHECKCC_UPSTREAM 必须是无凭证、无查询参数的 HTTP(S) 地址。");
  const probeTargets = new Map();
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
        if (!["/__checkcc/status", "/__checkcc/diagnostics", "/__checkcc/cloak", "/__checkcc/simulation", "/__checkcc/message-probe", "/__checkcc/browser-probe"].includes(pathname)) return sendJson(response, 404, { error: "未知诊断接口。" });
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
          cloak: { ...cloakState(), enabled: cloaked.enabled && Boolean(profile), target: profile },
        };
        if (pathname === "/__checkcc/diagnostics") {
          const signalId = new URL(rawPath, "http://localhost").searchParams.get("signal");
          if (signalId && !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(signalId)) return sendJson(response, 400, { error: "无效检测项。" });
          Object.assign(report, signalId ? await collect(upstream, { signalId }) : await networkDiagnostics());
          if (!signalId || ["edgeCountry", "edgeCity", "edgeColo"].includes(signalId)) {
            report.edge = await collectEdgeTrace();
            report.testedSignals = [...(report.testedSignals ?? []), "edgeCountry", "edgeCity", "edgeColo"];
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
      const isClaudeRequest = !isSimulation && request.method === "POST" && /\/v1\/messages\/?$/.test(target.pathname);
      const started = Date.now();
      const record = {
        startedAt: new Date().toISOString(), headers: safeHeaders(headers),
        // 改写前的客户端原始声明头，用于对比模拟保护是否真的生效。
        originalHeaders: safeHeaders(request.headers),
        method: request.method, endpoint: target.pathname.startsWith("/v1/") ? target.pathname.split("/").slice(0, 3).join("/") : "other",
        profileUpdatedAt: profile?.updatedAt ?? null, status: null, elapsedMs: null, tls: null,
      };
      if (!isSimulation && profile && cloaked.enabled) rewrites += 1;
      const proxy = transportRequest(target, { method: request.method, headers, signal: AbortSignal.timeout(120000) }, (upstreamResponse) => {
        record.status = upstreamResponse.statusCode ?? null;
        record.elapsedMs = Date.now() - started;
        record.tls = target.protocol === "https:" ? { authorized: upstreamResponse.socket.authorized === true, protocol: upstreamResponse.socket.getProtocol?.() ?? null } : null;
        if (isClaudeRequest) { lastRequest = record; lastFailure = null; lastClues = extractClientClues(request.headers); }
        const responseHeaders = { ...upstreamResponse.headers };
        const hopHeaders = String(responseHeaders.connection ?? "").toLowerCase().split(",").map((key) => key.trim());
        for (const key of ["transfer-encoding", "connection", "keep-alive", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", ...hopHeaders]) delete responseHeaders[key];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.on("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      proxy.on("error", (error) => {
        if (isClaudeRequest) lastFailure = { at: new Date().toISOString(), error: error.code ?? "UPSTREAM_ERROR" };
        if (!response.headersSent) sendJson(response, 502, { error: `网关无法连接上游：${error.code ?? "UPSTREAM_ERROR"}` });
        else response.destroy();
      });
      request.pipe(proxy);
      request.on("aborted", () => proxy.destroy());
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
