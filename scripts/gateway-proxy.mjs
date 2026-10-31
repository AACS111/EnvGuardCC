import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const proxySettingsFile = () => path.join(process.env.CHECKCC_STATE_DIR || path.join(root, 'node_modules/.check-cc-local'), 'proxy-settings.json');

export function parseMacProxy(output) {
  const fields = Object.fromEntries([...output.matchAll(/^\s*(\w+)\s*:\s*(.*?)\s*$/gm)].map(([, key, value]) => [key, value]));
  for (const protocol of ['HTTPS', 'HTTP']) {
    if (fields[protocol + 'Enable'] !== '1') continue;
    const host = fields[protocol + 'Proxy'], port = Number(fields[protocol + 'Port']);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@?#]/.test(host)) return { state: 'unsupported', detail: '系统静态代理地址或端口无效，请手动指定 HTTP 代理。' };
    return { state: 'configured', address: `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${port}`, detail: '使用 macOS 静态代理。' };
  }
  if (fields.ProxyAutoConfigEnable === '1' || fields.ProxyAutoDiscoveryEnable === '1') return { state: 'unsupported', detail: '系统使用 PAC 或自动发现，请指定本机 HTTP/混合代理地址。' };
  if (fields.SOCKSEnable === '1') return { state: 'unsupported', detail: '仅检测到 SOCKS 系统代理，请指定 HTTP/混合代理端口。' };
  if (!output.includes('<dictionary>')) return { state: 'failed', detail: '无法识别 macOS 系统代理返回值。' };
  return { state: 'disabled', detail: '未启用静态系统代理；连接使用系统路由，可能由 TUN 接管。' };
}

export function systemProxyStatus({ platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'darwin') {
    try { return parseMacProxy(run('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })); }
    catch { return { state: 'failed', detail: '读取 macOS 系统代理失败，请重试或手动指定代理。' }; }
  }
  if (platform !== 'win32') return { state: 'disabled', detail: '使用显式代理或系统路由。' };
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const query = name => run('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))) return { state: 'disabled' };
    const value = query('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1].trim();
    const protocols = Object.fromEntries((value || '').split(';').map(entry => entry.trim().split('=')));
    const address = value?.includes('=') ? protocols.https || protocols.http : value;
    return address ? { state: 'configured', address: `http://${address}` } : { state: 'disabled' };
  } catch { return { state: 'disabled' }; }
}

export function systemProxy(options) {
  const status = systemProxyStatus(options);
  if (status.state === 'failed' || status.state === 'unsupported') throw new Error(status.detail);
  return status.address || null;
}

export function validateProxySettings(value) {
  if (!value || !['auto', 'manual', 'direct'].includes(value.mode)) throw new Error('请选择自动、手动代理或系统路由。');
  if (value.mode !== 'manual') return { mode: value.mode };
  const proxy = resolveProxy({ CHECKCC_PROXY: value.address }, null);
  if (!proxy || proxy.url.username || proxy.url.password) throw new Error('请填写不带认证的 HTTP/HTTPS 代理地址；受控浏览器不支持代理认证。');
  return { mode: 'manual', address: proxy.url.origin };
}

export function readProxySettings() {
  try { return validateProxySettings(JSON.parse(readFileSync(proxySettingsFile(), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { mode: 'auto' }; throw new Error('代理配置无法读取，请重新保存代理设置。', { cause: error }); }
}

export function resolveProxy(env = process.env, providedSystemProxy) {
  if (env.CHECKCC_PROXY === 'direct') return null;
  const explicit = env.CHECKCC_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const raw = explicit || (providedSystemProxy === undefined ? systemProxy() : providedSystemProxy);
  if (!raw) return null;
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('网关需要 HTTP/HTTPS 代理地址。请使用当前 VPN 软件提供的 HTTP/混合代理端口，或通过系统路由/TUN 接入。');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('代理地址不能包含路径、查询或片段。');
  return { url, source: explicit ? 'environment' : 'system' };
}

export function selectedProxy() {
  const explicit = resolveProxy(process.env, null);
  if (explicit || process.env.CHECKCC_PROXY === 'direct') return explicit;
  const settings = readProxySettings();
  if (settings.mode === 'direct') return null;
  if (settings.mode === 'manual') return { ...resolveProxy({}, settings.address), source: 'settings' };
  return resolveProxy({}, systemProxy());
}

export function proxyStatus() {
  const settings = readProxySettings();
  try {
    const selected = selectedProxy();
    return { settings, state: selected ? 'configured' : 'system-route', source: selected?.source || (settings.mode === 'direct' || process.env.CHECKCC_PROXY === 'direct' ? 'direct' : 'system'), address: selected?.url.origin || null, detail: selected ? '已选择代理；连接结果需实际验证。修改后重新接入受控浏览器。' : '使用系统路由；TUN 是否生效需以实际流量验证。' };
  } catch (error) { return { settings, state: 'unavailable', source: 'system', address: null, detail: error.message }; }
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
