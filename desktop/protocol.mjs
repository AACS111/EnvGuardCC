import { createInterface } from 'node:readline';

// Only this channel writes to stdout. Application logs belong on stderr.
export function createProtocol({ input, output, dispatch, onDisconnect = () => {}, timeout = 120000 }) {
  const pending = new Map();
  let sequence = 0, closed = false;
  const send = message => { if (!closed) output.write(JSON.stringify(message) + '\n'); };
  const lines = createInterface({ input, crlfDelay: Infinity });
  output.on('error', () => lines.close());
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'response') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
    } else if (message.type === 'request' && Number.isSafeInteger(message.id)) {
      void Promise.resolve().then(() => dispatch(message.method, message.params)).then(
        result => send({ type: 'response', id: message.id, result }),
        error => send({ type: 'response', id: message.id, error: error.message }),
      );
    }
  });
  lines.on('close', () => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('桌面宿主连接已断开。')); }
    pending.clear();
    void onDisconnect();
  });
  return {
    send,
    request(method, params) {
      if (closed) return Promise.reject(new Error('桌面宿主连接已断开。'));
      const id = `native-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`原生操作超时：${method}`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        send({ type: 'request', id, method, params });
      });
    },
    close: () => lines.close(),
  };
}
