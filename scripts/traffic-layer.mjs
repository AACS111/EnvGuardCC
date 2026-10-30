import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function target(value, connect = false) {
  if (typeof value !== 'string' || /[\s@#?]/.test(value) && connect) throw new Error('无效目标');
  const url = new URL(connect ? `http://${value}` : value);
  if (url.protocol !== 'http:' || url.username || url.password || (connect && url.pathname !== '/')) throw new Error('仅支持 HTTP 或 CONNECT');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0') throw new Error('禁止代理到本机，防止循环');
  if (connect && !url.port && !/:80$/.test(value)) throw new Error('CONNECT 必须指定端口');
  return { url, authority: connect ? value : url.host };
}
const HOP = ['proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headers(input) {
  const result = { ...input };
  const connection = String(input.connection ?? '').split(',').map(item => item.trim().toLowerCase());
  for (const name of [...HOP, ...connection]) delete result[name];
  return result;
}

export function createTrafficLayer({ loadConfig }) {
  const stats = { http: 0, tunnels: 0, denied: 0, failed: 0, active: 0 };
  const sockets = new Set();
  async function authorize(request) {
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) throw new Error('仅允许本机');
    const config = await loadConfig();
    if (config.version !== 1 || typeof config.secret !== 'string' || config.secret.length < 32) throw new Error('配置无效');
    const raw = request.headers['proxy-authorization'];
    if (!raw?.startsWith('Basic ')) throw new Error('缺少拦截层认证');
    const decoded = Buffer.from(raw.slice(6), 'base64').toString(), split = decoded.indexOf(':');
    const id = decoded.slice(0, split), password = Buffer.from(decoded.slice(split + 1));
    const expected = Buffer.from(config.secret);
    if (split < 0 || password.length !== expected.length || !timingSafeEqual(password, expected)) throw new Error('认证失败');
    const route = config.routes?.find(route => route.id === id);
    if (!route) throw new Error('未知回程入口');
    const upstream = new URL(route.upstream);
    if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || Number(upstream.port) === config.listenPort || !upstream.port || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('回程入口必须是不同端口的本机 HTTP 监听器');
    return upstream;
  }
  const server = http.createServer(async (request, response) => {
    let upstream;
    try { upstream = await authorize(request); }
    catch { stats.denied++; response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="EnvGuardCC"' }); response.end(); return; }
    if (request.method === 'GET' && request.url === '/__checkcc/traffic/status') {
      response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify({kind:'checkcc-traffic-layer',version:1,stats})); return;
    }
    let destination;
    try { destination = target(request.url); }
    catch { response.writeHead(400); response.end(); return; }
    stats.http++;
    const forwarded = http.request(upstream, { method: request.method, path: destination.url.href, headers: { ...headers(request.headers), host: destination.url.host } }, received => {
      response.writeHead(received.statusCode ?? 502, headers(received.headers)); received.pipe(response);
    });
    forwarded.setTimeout(15000, () => forwarded.destroy(new Error('上游超时')));
    forwarded.on('error', () => { stats.failed++; if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => forwarded.destroy()); response.on('close', () => forwarded.destroy());
    request.pipe(forwarded);
  });
  server.on('connection', socket => { sockets.add(socket); stats.active++; socket.on('close', () => { sockets.delete(socket); stats.active--; }); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {});
    let upstream;
    try { upstream = await authorize(request); }
    catch { stats.denied++; client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="EnvGuardCC"\r\n\r\n'); return; }
    try { target(request.url, true); }
    catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const connection = http.request(upstream, { method: 'CONNECT', path: request.url, headers: { host: request.url }, agent: false });
    let tunnel;
    client.on('close', () => { connection.destroy(); tunnel?.destroy(); });
    connection.on('error', () => { stats.failed++; if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    connection.setTimeout(10000, () => connection.destroy(new Error('回程超时')));
    connection.on('connect', (response, socket, upstreamHead) => {
      tunnel = socket; sockets.add(socket); socket.on('close', () => { sockets.delete(socket); client.destroy(); });
      socket.on('error', () => client.destroy());
      if (response.statusCode !== 200 || client.destroyed) { stats.failed++; socket.destroy(); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
      stats.tunnels++; socket.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
    });
    connection.end();
  });
  return { server, stats, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

export async function startTrafficLayer(configPath) {
  const loadConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const config = await loadConfig(), layer = createTrafficLayer({ loadConfig });
  await new Promise((resolve, reject) => { layer.server.once('error', reject); layer.server.listen(config.listenPort, '127.0.0.1', resolve); });
  return layer;
}
export async function startConfiguredTrafficLayer(configPath) {
  let config;
  try { config = JSON.parse(await readFile(configPath,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; throw error; }
  if (!config.applied) return null;
  try { return await startTrafficLayer(configPath); }
  catch(error) {
    if(error.code!=='EADDRINUSE') throw error;
    const auth=`Basic ${Buffer.from(`${config.routes[0]?.id}:${config.secret}`).toString('base64')}`;
    const response=await fetch(`http://127.0.0.1:${config.listenPort}/__checkcc/traffic/status`,{headers:{'Proxy-Authorization':auth},signal:AbortSignal.timeout(2000)});
    const report=await response.json();
    if(!response.ok || report.kind!=='checkcc-traffic-layer' || report.version!==1) throw new Error('拦截端口被其他服务占用');
    return {server:null,close:async()=>{}};
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2] ?? path.resolve('node_modules/.check-cc-local/traffic-layer.json');
  const layer = await startTrafficLayer(configPath);
  console.log(`EnvGuardCC 流量拦截入口已监听 127.0.0.1:${layer.server.address().port}`);
  const close = async () => { await layer.close(); process.exitCode = 0; };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
