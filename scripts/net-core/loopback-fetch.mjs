import { request } from 'node:http';

// Control traffic must never inherit an Internet proxy or share its fetch pool.
// Literal loopback addresses also avoid system DNS and its worker queue.
export async function loopbackFetch(input, { method = 'GET', headers = {}, body, signal } = {}) {
  const url = new URL(input);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('控制请求只允许使用本机 HTTP 回环地址。');
  }
  signal ??= AbortSignal.timeout(8000);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, signal, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('本机控制响应在完成前中断。')));
      response.on('end', () => {
        try {
          const status = response.statusCode;
          const payload = [204, 205, 304].includes(status) || method === 'HEAD' ? null : Buffer.concat(chunks);
          resolve(new Response(payload, { status, headers: response.headers }));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', error => reject(signal.aborted ? signal.reason : error));
    req.end(body);
  });
}
