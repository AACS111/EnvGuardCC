// 订阅解析：把用户能拿到的三种来源统一成 mihomo 的 proxies 数组。
//   - Clash 配置（你的订阅就是这种：proxies / proxy-groups / rules）
//   - 分享链接（ss:// vmess:// trojan:// vless://），可能整体 base64
//   - 手工填写（由界面直接传结构）
// 解析失败不静默：无效条目计数并给出原因，绝不把"没解析到"当成"导入成功"。

import { parse as parseYaml } from "yaml";
import { proxyRequest } from "../gateway-proxy.mjs";

export const MAX_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;
const SHARE_SCHEMES = /^(ss|ssr|vmess|trojan|vless|anytls|hysteria2?|tuic):\/\//i;

function toInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : null;
}

function safeName(name, index) {
  const value = String(name ?? "").trim();
  return value || `节点 ${index + 1}`;
}

function base64Decode(text) {
  const normalized = String(text).replace(/[\r\n\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseQuery(text) {
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

/** 分享链接 → mihomo 节点。无法识别的返回 null。 */
export function shareLinkToProxy(link, index = 0) {
  const raw = String(link ?? "").trim();
  if (!raw) return null;
  const scheme = raw.slice(0, raw.indexOf("://")).toLowerCase();
  if (scheme === "ss") {
    // SIP002：ss://base64(method:pass)@host:port#name 或整体 base64。
    const [beforeHash, hash = ""] = raw.slice(5).split("#");
    const name = decodeURIComponent(hash) || `ss ${index + 1}`;
    const at = beforeHash.lastIndexOf("@");
    if (at < 0) {
      const decoded = base64Decode(beforeHash.split("?")[0]);
      const match = decoded.match(/^([^:]+):(.+)@(.+):(\d+)$/);
      if (!match) return null;
      return { name, type: "ss", cipher: match[1], password: match[2], server: match[3], port: toInt(match[4]) };
    }
    const credentials = beforeHash.slice(0, at).split("?")[0];
    const hostPart = beforeHash.slice(at + 1).split("?")[0];
    const match = hostPart.match(/^(.+):(\d+)$/);
    if (!match) return null;
    const decoded = credentials.includes(":") ? credentials : base64Decode(credentials);
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { name, type: "ss", cipher: decoded.slice(0, separator), password: decoded.slice(separator + 1), server: match[1], port: toInt(match[2]) };
  }
  if (scheme === "vmess") {
    const decoded = base64Decode(raw.slice(8));
    if (!decoded) return null;
    let config;
    try { config = JSON.parse(decoded); } catch { return null; }
    const port = toInt(config.port);
    if (!config.add || !port || !config.id) return null;
    const network = String(config.net || "tcp");
    const proxy = {
      name: String(config.ps || `vmess ${index + 1}`),
      type: "vmess", server: String(config.add), port,
      uuid: String(config.id), alterId: Number(config.aid) || 0, cipher: String(config.scy || "auto"),
      network,
    };
    if (config.tls === "tls" || config.tls === true) { proxy.tls = true; if (config.sni || config.host) proxy.servername = String(config.sni || config.host); }
    if (network === "ws") proxy["ws-opts"] = { path: String(config.path || "/"), ...(config.host ? { headers: { Host: String(config.host) } } : {}) };
    return proxy;
  }
  if (scheme === "trojan" || scheme === "vless") {
    const body = raw.slice(raw.indexOf("://") + 3);
    const [beforeHash, hash = ""] = body.split("#");
    const [authority, query = ""] = beforeHash.split("?");
    const at = authority.lastIndexOf("@");
    if (at < 0) return null;
    const credential = decodeURIComponent(authority.slice(0, at));
    const hostPart = authority.slice(at + 1);
    const match = hostPart.match(/^(.+):(\d+)$/);
    if (!match) return null;
    const params = parseQuery(query);
    const name = decodeURIComponent(hash) || `${scheme} ${index + 1}`;
    const proxy = { name, type: scheme, server: match[1], port: toInt(match[2]) };
    if (scheme === "trojan") proxy.password = credential;
    else proxy.uuid = credential;
    if (params.security === "reality") {
      proxy.tls = true;
      proxy["reality-opts"] = { "public-key": params.pbk, "short-id": params.sid ?? "" };
      if (params.fp) proxy["client-fingerprint"] = params.fp;
    } else if (params.security === "tls" || scheme === "trojan") {
      proxy.tls = true;
    }
    if (params.sni) proxy.servername = params.sni;
    if (params.type && params.type !== "tcp") proxy.network = params.type === "grpc" ? "grpc" : params.type;
    if (params.flow) proxy.flow = params.flow;
    return proxy;
  }
  if (scheme === "anytls") {
    // anytls://password@host:port?sni=...&insecure=1#name
    const body = raw.slice(raw.indexOf("://") + 3);
    const [beforeHash, hash = ""] = body.split("#");
    const [authority, query = ""] = beforeHash.split("?");
    const at = authority.lastIndexOf("@");
    if (at < 0) return null;
    const password = decodeURIComponent(authority.slice(0, at));
    const match = authority.slice(at + 1).match(/^(.+):(\d+)$/);
    if (!match) return null;
    const params = parseQuery(query);
    const proxy = {
      name: decodeURIComponent(hash) || `anytls ${index + 1}`,
      type: "anytls",
      server: match[1],
      port: toInt(match[2]),
      password,
      tls: true,
    };
    if (params.sni) proxy.servername = params.sni;
    if (params.insecure === "1" || params.allowInsecure === "1") proxy["skip-cert-verify"] = true;
    if (params.fp) proxy["client-fingerprint"] = params.fp;
    return proxy;
  }
  // ssr / hysteria / tuic：mihomo 支持，但所需字段较多；不猜测，明确报告不支持。
  return null;
}

/** Clash 配置文本 → proxies。 */
export function parseClashConfig(text) {
  let document;
  try { document = parseYaml(String(text)); }
  catch (error) { throw new Error(`Clash 配置解析失败：${error.message}`); }
  if (!document || typeof document !== "object") throw new Error("Clash 配置不是有效的 YAML 对象。");
  const proxies = Array.isArray(document.proxies) ? document.proxies : [];
  if (!proxies.length) throw new Error("Clash 配置中没有 proxies 节点。");
  // 订阅自带的 DNS 不是可选项：节点服务器常用服务商私有域名（如 *.private.xxx.xyz），
  // 公共 DNS 解析不出来，节点就会全部超时（实测事故）。把 proxy-server-nameserver 带出去给内核用。
  const proxyServerDns = Array.isArray(document.dns?.["proxy-server-nameserver"])
    ? document.dns["proxy-server-nameserver"].filter((item) => typeof item === "string" && item.trim()).slice(0, 8)
    : [];
  return { proxies, source: "clash", groups: document["proxy-groups"] ?? [], rules: document.rules ?? [], proxyServerDns };
}

/** 整体 base64 的分享链接列表 → 文本。 */
function decodeLinkList(text) {
  const trimmed = String(text).trim();
  if (SHARE_SCHEMES.test(trimmed)) return trimmed;
  const decoded = base64Decode(trimmed);
  return SHARE_SCHEMES.test(decoded) ? decoded : trimmed;
}

export function parseShareLinks(text) {
  const body = decodeLinkList(text);
  const links = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => SHARE_SCHEMES.test(line));
  if (!links.length) throw new Error("没有识别到分享链接（ss/vmess/trojan/vless/anytls）。");
  const proxies = [];
  const skipped = [];
  links.forEach((link, index) => {
    const proxy = shareLinkToProxy(link, index);
    if (proxy && proxy.server && toInt(proxy.port)) proxies.push(proxy);
    else skipped.push({ link: link.slice(0, 48), reason: "字段不完整或类型暂不支持" });
  });
  if (!proxies.length) throw new Error("分享链接均无法解析。");
  return { proxies, source: "links", skipped };
}

/** 返回内容的体检：导入失败时必须能看出“服务器到底给了什么”，而不是让人对着一句笼统报错猜。 */
export function describeSubscriptionContent(text) {
  const head = String(text ?? "").trim().slice(0, 160).replace(/\s+/g, " ");
  if (/^<(!doctype|html|\?xml)/i.test(head)) {
    return { kind: "html", head, hint: "返回的是网页而不是订阅内容：多半是订阅域名已失效/被跳转到门户页，或链接被浏览器缓存页/防火墙拦截页替代。" };
  }
  if (/^[[{]/.test(head)) {
    return { kind: "json", head, hint: "返回的是 JSON，不是 Clash 配置或分享链接（部分服务商用 JSON 接口，不能直接当订阅地址）。" };
  }
  if (/^(proxy-providers|proxy-groups|rules)\s*:/m.test(String(text))) {
    return { kind: "clash-partial", head, hint: "看起来是 Clash 配置，但只有 proxy-providers/规则，没有内联 proxies；本程序只能导入内联节点。" };
  }
  return { kind: "unknown", head, hint: "内容既不是 YAML，也不是 ss/vmess/trojan/vless 链接或它们的 base64。" };
}

/** 自动识别来源类型。 */
export function parseSubscription(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("订阅内容为空。");
  if (raw.length > MAX_SUBSCRIPTION_BYTES) throw new Error("订阅内容过大。");
  if (/^proxies\s*:/m.test(raw) || /\nproxies\s*:/m.test(raw)) return parseClashConfig(raw);
  if (SHARE_SCHEMES.test(raw)) return parseShareLinks(raw);
  const decoded = base64Decode(raw);
  if (SHARE_SCHEMES.test(decoded)) return parseShareLinks(raw);
  if (/^proxies\s*:/m.test(decoded)) return parseClashConfig(decoded);
  const { head, hint } = describeSubscriptionContent(raw);
  throw new Error(`无法识别的订阅格式：既不是 Clash 配置，也不是分享链接。${hint}（返回内容开头：${head || "空"}）`);
}

/** 名称去重、字段校验：无效条目进入 skipped，不阻断整体导入。 */
export function normalizeProxies(proxies) {
  const used = new Set();
  const accepted = [];
  const skipped = [];
  (Array.isArray(proxies) ? proxies : []).forEach((item, index) => {
    if (!item || typeof item !== "object") { skipped.push({ index, reason: "不是对象" }); return; }
    const port = toInt(item.port);
    if (typeof item.server !== "string" || !item.server.trim() || !port) { skipped.push({ index, reason: "缺少 server/port" }); return; }
    if (typeof item.type !== "string" || !item.type.trim()) { skipped.push({ index, reason: "缺少 type" }); return; }
    let name = safeName(item.name, index);
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name} #${suffix}`)) suffix += 1;
      name = `${name} #${suffix}`;
    }
    used.add(name);
    accepted.push({ ...item, name, port });
  });
  return { proxies: accepted, skipped };
}

/** 抓取订阅。只允许 http/https，限制体积，保留真实错误。 */
// 订阅服务商普遍按 UA 放行：只认 Clash / v2ray 之类客户端的 UA，未知客户端直接 403。
// 首次仍以本程序身份请求（服务端日志能认出来源）；被拒时再用通用客户端 UA 重试。
// 顺序即尝试顺序。多数机场按客户端白名单放行，FlClash 是被接受面最广的桌面客户端之一，
// 所以默认先以它自报身份；被拒再退回本程序身份与 Clash Verge。
// CHECKCC_SUBSCRIPTION_UA 可指定任意 UA（覆盖整个列表），用于只放行特定客户端的机场。
export const SUBSCRIPTION_UA_PROFILES = [
  "FlClash/0.9.0",
  "ClashMetaForAndroid/2.10.1",
  "clash-verge/v2.0",
  "ClashforWindows/0.20.39",
  "EnvGuardCC/1.0",
];

/** 网络层错误分类：订阅域名失效时表现为 403 / 连接重置，不解释清楚只会让人怀疑程序坏了。 */
function explainNetworkError(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `订阅域名无法解析（${code}）：链接可能已失效，或域名已被服务商更换。`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `与订阅服务器的连接被重置（${code}）：域名可能已失效，或当前节点无法到达该站。`;
  if (code === "ETIMEDOUT" || error?.name === "TimeoutError") return `连接订阅服务器超时（${code || "TIMEOUT"}）：请检查节点连通性，或换一个节点再试。`;
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return `订阅站证书校验失败（${code}）：可能是中间人/劫持，也可能是站点证书过期。`;
  return error?.message || "订阅下载失败。";
}

export async function fetchSubscription(url, { download = defaultFetch, timeoutMs = 15000, signal } = {}) {
  signal?.throwIfAborted();
  let target;
  try { target = new URL(String(url)); }
  catch { throw new Error("订阅地址无效。"); }
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("订阅地址必须是 http 或 https。");
  const text = await download(target.href, { timeoutMs, signal });
  signal?.throwIfAborted();
  if (typeof text !== "string" || !text.trim()) throw new Error("订阅返回内容为空。");
  if (Buffer.byteLength(text) > MAX_SUBSCRIPTION_BYTES) throw new Error("订阅内容过大。");
  return text;
}

/**
 * 经本地代理（FlClash / Clash Verge 等的混合端口）取文本。
 * 用户机器上已有的代理工具往往能下到本程序直连下不到的订阅，借它一用比让用户手动折腾更实际。
 */
export function fetchTextViaProxy(url, { proxy, userAgent = "EnvGuardCC/1.0", timeoutMs = 15000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") return Promise.reject(new Error("只支持 http/https。"));
  const proxyUrl = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
  return new Promise((resolve, reject) => {
    const onAbort = () => request.destroy(signal.reason);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const timer = setTimeout(() => { request.destroy(new Error("PROXY_TIMEOUT")); }, timeoutMs);
    const request = proxyRequest(target, { method: "GET", headers: { "User-Agent": userAgent, Accept: "*/*" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        cleanup();
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 300) { const error = new Error(`HTTP ${response.statusCode}`); error.status = response.statusCode; reject(error); return; }
        resolve(body);
      });
      response.on("error", (error) => { cleanup(); reject(error); });
    }, { url: proxyUrl, source: "local-proxy" });
    request.once("error", (error) => { cleanup(); reject(error); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    request.end();
  });
}

/**
 * 订阅站常见坑：同一个链接按 UA 返回不同格式（Clash YAML / base64 分享链接 / HTML 错误页），
 * 甚至 200 + 错误页。拿到 200 不等于拿到了可用订阅，必须校验内容再决定是否换下一个 UA。
 */
export function looksLikeSubscription(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (/(^|\n)\s*proxies\s*:/m.test(raw)) return true;
  if (SHARE_SCHEMES.test(raw)) return true;
  const decoded = base64Decode(raw);
  return SHARE_SCHEMES.test(decoded) || /(^|\n)\s*proxies\s*:/m.test(decoded);
}

export async function defaultFetch(url, { timeoutMs = 15000, fetchImpl = globalThis.fetch, userAgents, scan, proxyFetch = fetchTextViaProxy, signal } = {}) {
  const override = typeof process.env.CHECKCC_SUBSCRIPTION_UA === "string" ? process.env.CHECKCC_SUBSCRIPTION_UA.trim() : "";
  const profiles = userAgents ?? (override ? [override] : SUBSCRIPTION_UA_PROFILES);
  let lastStatus = null;
  let directFailure = null;
  for (const userAgent of profiles) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, { redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { "User-Agent": userAgent } });
    } catch (error) {
      signal?.throwIfAborted();
      // 单个 UA 的连接被重置不代表订阅不可用：换下一个 UA 继续试。
      directFailure = explainNetworkError(error);
      continue;
    }
    // 401/403/406 是「按客户端拒绝」的典型状态码：换下一个 UA 再试，不把 UA 问题报成链接失效。
    if ([401, 403, 406].includes(response.status) && userAgent !== profiles[profiles.length - 1]) {
      lastStatus = response.status;
      continue;
    }
    if (!response.ok) {
      const hint = [401, 403, 406].includes(response.status)
        ? "：服务器拒绝了这个客户端；链接可能已失效，或订阅站只放行特定客户端 UA。"
        : "。";
      directFailure = `HTTP ${response.status}${hint}`;
      break;
    }
    const text = await response.text();
    signal?.throwIfAborted();
    if (looksLikeSubscription(text)) return text;
    // 200 但内容是错误页/不兼容格式：记录原因并换下一个 UA。
    directFailure = "订阅返回内容不是可识别的 Clash 配置或分享链接。";
    continue;
  }
  const directReason = directFailure ?? `HTTP ${lastStatus ?? "未知"}`;
  // 直连拿不到时借本地代理（FlClash / Clash Verge 等）再试一次：
  // 用户机器上那两个客户端能下到的订阅，本程序直连未必下得到（节点、DNS、UA 都可能不一样）。
  signal?.throwIfAborted();
  const borrowed = await tryLocalProxies(url, { profiles, timeoutMs, scan, proxyFetch, signal });
  if (borrowed.text) return borrowed.text;
  const tries = borrowed.failures.length ? `；已尝试本地代理：${borrowed.failures.join("、")}` : "";
  throw new Error(`订阅下载失败：${directReason}${tries}`);
}

/** 依次尝试扫描到的本地代理端口；成功返回文本，失败则记录每个端口的原因。 */
async function tryLocalProxies(url, { profiles, timeoutMs, scan, proxyFetch, signal }) {
  const failures = [];
  let list = [];
  try {
    const { scanLocalProxies } = await import("./local-proxy.mjs");
    list = await (scan ?? scanLocalProxies)();
  } catch (error) {
    signal?.throwIfAborted();
    return { text: null, failures: [`扫描失败（${error.message}）`] };
  }
  signal?.throwIfAborted();
  // 只用 HTTP 协议端口：CONNECT 通道对 https 订阅才成立。
  for (const item of list.filter((entry) => entry.protocol === "http")) {
    for (const userAgent of profiles) {
      signal?.throwIfAborted();
      try {
        const body = await proxyFetch(url, { proxy: `http://127.0.0.1:${item.port}`, userAgent, timeoutMs, signal });
        signal?.throwIfAborted();
        if (looksLikeSubscription(body)) return { text: body, failures };
        failures.push(`${item.tool}:${item.port}（返回内容不是可识别的订阅格式）`);
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.status && [401, 403, 406].includes(error.status) && userAgent !== profiles[profiles.length - 1]) continue;
        failures.push(`${item.tool}:${item.port}（${error.message}）`);
        break;
      }
    }
  }
  return { text: null, failures };
}
