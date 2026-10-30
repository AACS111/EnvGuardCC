import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";
import { execFileSync } from "node:child_process";

export function systemProxy() {
  if (process.platform !== "win32") return null;
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const query = (name) => execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true, timeout: 2000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(query("ProxyEnable"))) return null;
    const value = query("ProxyServer").match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1].trim();
    if (!value) return null;
    if (!value.includes("=")) return `http://${value}`;
    const protocols = Object.fromEntries(value.split(";").map((entry) => entry.trim().split("=")));
    const address = protocols.https || protocols.http;
    return address ? `http://${address}` : null;
  } catch { return null; }
}

export function resolveProxy(env = process.env, windowsProxy) {
  if (env.CHECKCC_PROXY === "direct") return null;
  const explicit = env.CHECKCC_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const raw = explicit || (windowsProxy === undefined ? systemProxy() : windowsProxy);
  if (!raw) return null;
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("网关需要 HTTP/HTTPS 代理地址。请使用当前 VPN 软件提供的 HTTP 代理端口，或通过系统代理/TUN 接入。");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("代理地址不能包含路径、查询或片段。");
  return { url, source: explicit ? "environment" : "system" };
}

export function selectedProxy() {
  // The user may switch VPN applications or ports while EnvGuardCC is running.
  return resolveProxy();
}

function loopback(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);
}

export function proxyInfo(url) {
  const proxy = loopback(url.hostname) ? null : selectedProxy();
  return proxy ? { mode: "http-connect", source: proxy.source, address: proxy.url.origin } : { mode: "direct", source: "direct", address: null };
}

// CONNECT 始终把目标域名交给代理；HTTPS 仍校验目标证书，不降级 TLS。
export function proxyRequest(url, options, onResponse, proxyOverride) {
  const proxy = proxyOverride === undefined ? (loopback(url.hostname) ? null : selectedProxy()) : proxyOverride;
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  if (!proxy) return transport.request(url, options, onResponse);
  const lifecycle = new AbortController();
  const originalAbort = () => lifecycle.abort();
  options.signal?.addEventListener("abort", originalAbort, { once: true });
  if (options.signal?.aborted) lifecycle.abort();
  const agent = new (secure ? https.Agent : http.Agent)({ keepAlive: false });
  agent.createConnection = (connectionOptions, callback) => {
    const port = url.port || (secure ? "443" : "80");
    const authority = `${url.hostname}:${port}`;
    const headers = { Host: authority };
    if (proxy.url.username || proxy.url.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`).toString("base64")}`;
    let socket;
    let settled = false;
    const finish = (error, connected) => {
      if (settled) return;
      settled = true;
      lifecycle.signal.removeEventListener("abort", abort);
      callback(error, connected);
    };
    const connect = (proxy.url.protocol === "https:" ? https : http).request(proxy.url, { method: "CONNECT", path: authority, headers, agent: false });
    const abort = () => {
      const error = new Error("Proxy connection aborted");
      error.code = "ABORT_ERR";
      socket?.destroy();
      connect.destroy(error);
      finish(error);
    };
    connect.once("error", (error) => finish(error));
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    if (lifecycle.signal.aborted) { abort(); return; }
    connect.setTimeout(5000, () => {
      const error = new Error("Proxy CONNECT timed out");
      error.code = "PROXY_CONNECT_TIMEOUT";
      connect.destroy(error);
    });
    connect.once("connect", (response, tunnel, head) => {
      socket = tunnel;
      if (settled) { tunnel.destroy(); return; }
      if (response.statusCode !== 200) {
        tunnel.destroy();
        const error = new Error(`Proxy CONNECT HTTP ${response.statusCode}`);
        error.code = "PROXY_CONNECT_FAILED";
        finish(error);
        return;
      }
      tunnel.setTimeout(0);
      if (head.length) tunnel.unshift(head);
      if (!secure) { finish(null, tunnel); return; }
      socket = tls.connect({ ...connectionOptions, socket: tunnel, servername: isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true });
      socket.once("error", (error) => finish(error));
      socket.once("secureConnect", () => finish(null, socket));
    });
    connect.end();
  };
  const request = transport.request(url, { ...options, agent }, onResponse);
  const destroy = request.destroy.bind(request);
  request.destroy = (error) => {
    lifecycle.abort();
    return destroy(error);
  };
  request.once("close", () => {
    lifecycle.abort();
    options.signal?.removeEventListener("abort", originalAbort);
  });
  return request;
}
