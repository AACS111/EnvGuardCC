import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { proxyRequest } from './gateway-proxy.mjs';

const hopHeaders = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headers(input) {
  const result = { ...input };
  for (const name of [...hopHeaders, ...String(input.connection ?? '').toLowerCase().split(',').map(value => value.trim())]) delete result[name];
  return result;
}
function destination(raw, tunnel) {
  if (!raw || /[\s\\]/.test(raw)) throw new Error('无效代理目标');
  if (tunnel && !/^(?:\[[0-9a-f:.]+\]|[^:/?#@]+):\d{1,5}$/i.test(raw)) throw new Error('无效代理目标');
  const url = new URL(tunnel ? `http://${raw}` : raw);
  if (url.username || url.password || url.hash || (tunnel ? url.pathname !== '/' || url.search : url.protocol !== 'http:')) throw new Error('无效代理目标');
  if (tunnel && Number(raw.slice(raw.lastIndexOf(':') + 1)) < 1) throw new Error('无效代理端口');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)) throw new Error('禁止代理回本机');
  return url;
}

// Desktop HTTPS is tunneled intact. No certificates, cookies, or message bodies are inspected.
export function createDesktopGateway({ proxy = null } = {}) {
  const sockets = new Set();
  const pending = new Set();
  const stats = { requests: 0, tunnels: 0, failed: 0, lastConnection: null };
  let closed = false;
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const record = (url, state, error = null) => {
    stats.lastConnection = { host: url.hostname, port: Number(url.port || 80), state, error, at: new Date().toISOString() };
    if (state === 'failed') stats.failed++;
  };
  const local = request => !closed && ['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  const server = http.createServer((request, response) => {
    if (!local(request)) { response.writeHead(403); response.end(); return; }
    let url;
    try { url = destination(request.url, false); } catch { response.writeHead(400); response.end(); return; }
    const forwarded = proxyRequest(url, { method: request.method, headers: { ...headers(request.headers), host: url.host }, signal: AbortSignal.timeout(10000) }, received => {
      stats.requests++; record(url, 'connected');
      response.writeHead(received.statusCode ?? 502, headers(received.headers));
      received.pipe(response);
    }, proxy);
    pending.add(forwarded);
    forwarded.once('close', () => pending.delete(forwarded));
    response.once('close', () => { if (!response.writableFinished) forwarded.destroy(); });
    forwarded.on('error', error => { record(url, 'failed', error.code ?? 'NETWORK_ERROR'); if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (request, client, head) => {
    if (!local(request)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    let url;
    try { url = destination(request.url, true); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    let finished = false, outgoing, tunnel;
    const timer = setTimeout(() => fail('CONNECT_TIMEOUT'), 8000);
    const fail = code => {
      if (finished) return;
      finished = true; clearTimeout(timer); record(url, 'failed', code);
      outgoing?.destroy(); tunnel?.destroy();
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    };
    const connected = socket => {
      if (finished || client.destroyed || closed) { socket.destroy(); return; }
      finished = true; clearTimeout(timer); tunnel = track(socket);
      stats.tunnels++; record(url, 'connected');
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
      socket.once('close', () => client.destroy());
    };
    client.once('close', () => { clearTimeout(timer); outgoing?.destroy(); tunnel?.destroy(); });
    if (!proxy) {
      tunnel = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) });
      tunnel.once('error', error => fail(error.code ?? 'CONNECT_FAILED'));
      track(tunnel);
      tunnel.once('connect', () => connected(tunnel));
    } else {
      const auth = proxy.url.username || proxy.url.password ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`).toString('base64')}` } : {};
      const authority = `${url.hostname}:${url.port || 80}`;
      outgoing = (proxy.url.protocol === 'https:' ? https : http).request(proxy.url, { method: 'CONNECT', path: authority, headers: { host: authority, ...auth }, agent: false });
      pending.add(outgoing);
      outgoing.once('close', () => pending.delete(outgoing));
      outgoing.once('error', error => fail(error.code ?? 'PROXY_CONNECT_FAILED'));
      outgoing.once('response', response => { response.resume(); fail('PROXY_CONNECT_FAILED'); });
      outgoing.once('connect', (response, socket, upstreamHead) => {
        if (response.statusCode !== 200) { socket.destroy(); fail('PROXY_CONNECT_FAILED'); return; }
        if (upstreamHead.length) socket.unshift(upstreamHead);
        connected(socket);
      });
      outgoing.end();
    }
  });
  return {
    server,
    snapshot: () => structuredClone({ ...stats, mode: proxy ? 'proxy' : 'direct', upstream: proxy?.url.origin ?? null }),
    async close() {
      closed = true;
      for (const request of pending) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
