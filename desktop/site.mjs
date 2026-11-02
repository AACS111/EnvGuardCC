import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

export async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function startSite(directory, ports, port = 3030) {
  const root = await realpath(directory);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let file = await realpath(path.resolve(root, '.' + requested));
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      if ((await stat(file)).isDirectory()) file = await realpath(path.join(file, 'index.html'));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      let data = await readFile(file);
      if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('<head>', `<head><script>globalThis.__CHECKCC_PORTS__=${JSON.stringify(ports)}</script>`));
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server;
  } catch (error) { await closeServer(server); throw error; }
}
