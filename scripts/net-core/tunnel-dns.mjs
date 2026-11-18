import { spawn as nodeSpawn } from 'node:child_process';

// 保留 OS getaddrinfo（包括 NRPT、加密/分流 DNS）的判据。
// 将不可取消的查询隔离在可复用的子进程，超时只回收它，不占满主进程的 fs 线程池。
const workerSource = `
const dns = require('node:dns/promises');
process.on('message', async ({ id, host }) => {
  let reply;
  try { reply = { id, ...await dns.lookup(host, { family: 4 }) }; }
  catch (error) { reply = { id, error: { code: error.code, message: error.message } }; }
  if (process.connected) process.send(reply, () => {});
});
process.on('disconnect', () => process.exit(0));
`;

export function createTunnelLookup({ spawn = nodeSpawn } = {}) {
  let worker = null, sequence = 0, idleTimer = null;
  const pending = new Map();
  function finish(id, error, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    item.signal?.removeEventListener('abort', item.abort);
    if (error) item.reject(error); else item.resolve(value);
    if (!pending.size && worker) {
      worker.unref(); worker.channel?.unref();
      idleTimer = setTimeout(() => lookup.dispose(), 60000);
      idleTimer.unref?.();
    }
  }
  function discard(child, error) {
    if (worker === child) {
      worker = null;
      clearTimeout(idleTimer); idleTimer = null;
    }
    for (const [id, item] of pending) if (item.child === child) finish(id, error);
    if (!child.killed) child.kill('SIGKILL');
  }
  function startWorker() {
    const child = spawn(process.execPath, ['-e', workerSource], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    child.on('message', message => {
      if (pending.get(message?.id)?.child !== child) return;
      if (message.error) finish(message.id, Object.assign(new Error(message.error.message), { code: message.error.code }));
      else if (typeof message.address === 'string' && message.family === 4) finish(message.id, null, { address: message.address, family: 4 });
      else finish(message.id, new Error('隧道 DNS 工作进程返回无效答案。'));
    });
    child.once('error', error => discard(child, error));
    child.once('exit', () => discard(child, new Error('隧道 DNS 工作进程已退出。')));
    return child;
  }
  async function lookup(host, { signal } = {}) {
    signal?.throwIfAborted();
    clearTimeout(idleTimer); idleTimer = null;
    worker ??= startWorker();
    const child = worker, id = ++sequence;
    child.ref(); child.channel?.ref();
    return new Promise((resolve, reject) => {
      const abort = () => discard(child, signal.reason);
      pending.set(id, { child, resolve, reject, signal, abort });
      signal?.addEventListener('abort', abort, { once: true });
      try { child.send({ id, host, family: 4 }, error => { if (error) discard(child, error); }); }
      catch (error) { discard(child, error); }
    });
  }
  lookup.dispose = () => {
    if (worker) discard(worker, Object.assign(new Error('隧道 DNS 查询已停止。'), { code: 'ABORT_ERR' }));
  };
  return lookup;
}
