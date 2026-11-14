// Status polling must never wait for system commands or reuse stale data after failure.
// Configuration writes and backups continue to use the uncached system reader.
export function createTimezoneStatusReader(read, { now = Date.now, intervalMs = 10000, logger = console.error } = {}) {
  let pending = null;
  let nextRead = -Infinity;
  let generation = 0;
  let status = { systemTimezone: null, systemTimezoneError: null, systemTimezonePending: true };
  const snapshot = () => {
    if (!pending && now() >= nextRead) {
      status.systemTimezonePending = true;
      const version = generation;
      pending = Promise.resolve().then(read).then(zone => {
        if (version !== generation) return;
        status = { systemTimezone: zone || null, systemTimezoneError: null, systemTimezonePending: false };
      }, error => {
        if (version !== generation) return;
        status = { systemTimezone: null, systemTimezoneError: error.message, systemTimezonePending: false };
        logger('[repair] 系统时区状态读取失败：', error.message);
      }).finally(() => { if (version === generation) nextRead = now() + intervalMs; pending = null; });
    }
    return { ...status };
  };
  snapshot.invalidate = () => {
    generation++;
    nextRead = -Infinity;
    status = { systemTimezone: null, systemTimezoneError: null, systemTimezonePending: true };
    return { ...status };
  };
  return snapshot;
}
