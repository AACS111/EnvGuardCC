import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadIssuer, issueLicense } from './issuer.mjs';

const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const root = path.dirname(fileURLToPath(import.meta.url));

export async function startGenerator({ directory = path.resolve(root, '../../.checkcc-license-issuer'), port = 0 } = {}) {
  const issuer = await loadIssuer(directory);
  const token = randomBytes(32).toString('base64url');
  const fingerprint = createHash('sha256').update(issuer.publicKey).digest('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      if (!origin || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
        || req.socket.remoteAddress !== '127.0.0.1' || (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) {
        return send(403, { error: '仅允许生成器本机页面访问。' });
      }
      const asset = assets.get(req.url);
      if (req.method === 'GET' && asset) {
        let body = await readFile(path.join(root, asset[0]), 'utf8');
        if (req.url === '/') body = body.replace('__ISSUER_TOKEN__', token);
        return send(200, body, asset[1]);
      }
      const supplied = req.headers['x-checkcc-issuer-token'];
      if (typeof supplied !== 'string' || !/^[\w-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return send(403, { error: '生成器会话已失效，请刷新页面。' });
      }
      if (req.method === 'GET' && req.url === '/api/info') return send(200, { fingerprint, publicKey: issuer.publicKey });
      if (req.method !== 'POST' || req.url !== '/api/issue') return send(404, { error: '未找到此操作。' });
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: '请求来源或格式无效。' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { send(413, { error: '请求内容过长。' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: '请求 JSON 无效。' }); }
      if (!body || Object.keys(body).sort().join() !== 'accountUuid,usageHours') return send(400, { error: '请求字段无效。' });
      try { return send(200, issueLicense(body, issuer.privateKey)); }
      catch (error) { return send(400, { error: error.message }); }
    } catch {
      if (!res.headersSent) send(500, { error: '生成失败，请检查本机生成器文件和运行状态。' });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const generator = await startGenerator();
    console.log(`授权码生成器：${generator.url}`);
    console.log('仅供签发者使用；关闭此进程即停止生成器。');
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', generator.url], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => { console.error('自动打开失败，请手动打开上方本机地址。'); }); child.unref();
    }
    const stop = () => { void generator.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('生成器启动失败，请检查签发密钥目录；加密私钥需要正确的 CHECKCC_ISSUER_PASSPHRASE。'); process.exitCode = 1; }
}
