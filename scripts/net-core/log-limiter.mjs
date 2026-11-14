// Keep the first failure and periodic summaries, without hiding distinct causes.
export function createLogLimiter(logger, { now = Date.now, intervalMs = 30000, maxKeys = 128 } = {}) {
  const entries = new Map();
  function summary(key, entry) {
    if (entry.repeats) logger(`[log-summary] ${key}：重复 ${entry.repeats} 次；最近：${entry.last}`);
    entry.repeats = 0;
  }
  function write(key, message) {
    const time = now();
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) {
        const [oldKey, old] = entries.entries().next().value;
        summary(oldKey, old);
        entries.delete(oldKey);
      }
      entries.set(key, { at: time, repeats: 0, last: message });
      logger(message);
      return;
    }
    entry.repeats++;
    entry.last = message;
    if (time < entry.at || time - entry.at >= intervalMs) {
      summary(key, entry);
      entry.at = time;
    }
  }
  function clear(key) {
    const entry = entries.get(key);
    if (entry) summary(key, entry);
    entries.delete(key);
  }
  return { write, clear, flush: () => { for (const key of entries.keys()) clear(key); } };
}

// Aggregate known noisy warnings only. Errors and lifecycle transitions stay intact.
export function kernelWarningKey(line) {
  if (!/level=warning\b/.test(line)) return null;
  if (/Auto detect interface .*get empty name/.test(line)) return 'kernel: interface empty';
  if (/Auto detect interface .*failed, return/.test(line)) return 'kernel: interface unavailable';
  if (/activate health check/.test(line)) return 'kernel: group health check';
  const error = line.match(/error: (.*)/)?.[1];
  if (!error) return null;
  const cause = ['REALITY authentication failed', 'interface not found', 'context canceled',
    'operation was canceled', 'context deadline exceeded', 'i/o timeout',
    'unreachable host', 'unreachable network', 'all DNS requests failed'].find(value => error.includes(value));
  return cause ? `kernel: ${cause}` : null;
}
