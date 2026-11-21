// 只记录本机内核连接元数据。活动连接仅在内存，结束记录原子写入 state 目录。
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { connectionRoute, isClaudeHost, listConnections } from './routes.mjs';

export const CONNECTION_RETENTION_MS = 48 * 60 * 60 * 1000;
export const CONNECTION_MAX_ENTRIES = 20000;
export const CONNECTION_MAX_BYTES = 5 * 1024 * 1024;
const label = (value, limit = 256) => typeof value === 'string' ? value.split(/[?#]/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
export function requestEndpoint(value) {
  const pathname = String(value ?? '').split(/[?#]/)[0];
  if (/^\/v1\/(?:messages(?:\/count_tokens)?|complete|models)\/?$/.test(pathname)) return pathname.replace(/\/$/, '');
  if (/^\/v1\/models\/[^/]+\/?$/.test(pathname)) return '/v1/models/:id';
  return '/other';
}
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const bytes = value => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
function samplingErrorCode(error) {
  // 只输出白名单分类；异常 message/cause 可能包含控制令牌、代理凭证或 URL。
  const candidates = [error, error?.cause];
  if (candidates.some(item => item?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(item?.code))) return 'TIMEOUT';
  if (candidates.some(item => item?.name === 'AbortError' || item?.code === 'ABORT_ERR')) return 'ABORTED';
  const codes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'INVALID_RESPONSE'];
  return candidates.map(item => item?.code).find(code => codes.includes(code)) ?? (error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'UNKNOWN');
}
function hostOnly(value) {
  if (typeof value !== 'string') return '';
  try {
    const host = new URL(value.includes('://') ? value : `http://${value}`).hostname;
    return host.toLowerCase().replace(/\.$/, '').slice(0, 253);
  } catch { return ''; }
}

/** 白名单重新构造，绝不复制 metadata、URL、正文或进程字段。 */
export function connectionRecord(value, at = Date.now(), saved = false) {
  if (!value || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) return null;
  const metadata = saved ? value : value.metadata ?? {};
  const host = hostOnly(saved ? value.host : metadata.host || metadata.sniffHost);
  const ip = saved ? value.ip : metadata.destinationIP;
  const rawPort = saved ? value.port : metadata.destinationPort;
  const port = Number(rawPort);
  const chains = Array.isArray(value.chains) ? value.chains.filter(item => typeof item === 'string').slice(0, 16).map(item => label(item, 128)).filter(Boolean) : [];
  const route = connectionRoute({ chains });
  const start = timestamp(saved ? value.startedAt : value.start);
  const exitIp = (saved || value.kind === 'request') && typeof value.exitIp === 'string' && isIP(value.exitIp) ? value.exitIp : null;
  return {
    id: value.id, kind: value.kind === 'request' ? 'request' : 'connection', host, ip: typeof ip === 'string' && isIP(ip) ? ip : null,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    chains, rule: label(value.rule), rulePayload: label(value.rulePayload),
    upload: bytes(value.upload), download: bytes(value.download),
    startedAt: start && Date.parse(start) <= at ? start : new Date(at).toISOString(),
    endedAt: saved ? timestamp(value.endedAt) : null,
    isClaude: value.kind === 'request' || isClaudeHost(host), route, viaExit: route === 'unknown' ? null : route === 'proxied',
    ...(exitIp || value.kind === 'request' ? { exitIp } : {}),
    ...(value.kind === 'request' ? {
      method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value.method) ? value.method : 'OTHER',
      endpoint: requestEndpoint(value.endpoint),
      status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
      elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? Math.round(value.elapsedMs) : null,
      error: ['UPSTREAM_ERROR', 'CLIENT_ABORTED', 'STREAM_ERROR', 'STOPPED'].includes(value.error) ? value.error : null,
    } : {}),
  };
}

export async function createConnectionLog({ stateDir, readConnections, requestExit = () => null, connectionExit = () => null, now = Date.now, logger = () => {},
  scheduler = { every: setInterval, clear: clearInterval }, intervalMs = 1000,
  retentionMs = CONNECTION_RETENTION_MS, maxEntries = CONNECTION_MAX_ENTRIES, maxBytes = CONNECTION_MAX_BYTES,
  storageDelayMs = 0,
} = {}) {
  const file = path.join(stateDir, 'net-core-connections.json');
  const settingsFile = path.join(stateDir, 'net-core-connection-settings.json');
  const requestStatsFile = path.join(stateDir, 'net-core-request-counts.json');
  const requestCounts = new Map();
  let statsLoaded = false;
  let statsUnavailable = false;
  const parseRequestBuckets = raw => {
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.buckets)) throw new Error('Invalid request statistics');
    return data.buckets;
  };
  function rememberRequest(record, count = 1) {
    const at = typeof record.at === 'number' ? record.at : Date.parse(record.startedAt);
    if (!Number.isFinite(at) || at < now() - CONNECTION_RETENTION_MS || at > now() || !Number.isSafeInteger(count) || count < 1) return;
    const exitIp = typeof record.exitIp === 'string' && isIP(record.exitIp) ? record.exitIp : null;
    const key = `${at}|${exitIp ?? ''}`;
    const previous = requestCounts.get(key)?.count ?? 0;
    requestCounts.set(key, { at, exitIp, count: Math.min(Number.MAX_SAFE_INTEGER, previous + count) });
  }
  function pruneRequestCounts() {
    const cutoff = now() - CONNECTION_RETENTION_MS;
    for (const [key, bucket] of requestCounts) if (bucket.at < cutoff || bucket.at > now()) requestCounts.delete(key);
  }
  async function recoverRequestCounts() {
    if (!statsUnavailable) return true;
    try {
      const buckets = parseRequestBuckets(await readFile(requestStatsFile, 'utf8'));
      const pending = [...requestCounts.values()];
      requestCounts.clear();
      for (const bucket of [...buckets, ...pending]) rememberRequest(bucket, bucket.count);
      statsLoaded = true;
      statsUnavailable = false;
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      statsUnavailable = false;
      return true;
    }
  }
  let scope = 'all', sampledAt = null;
  try { const settings = JSON.parse(await readFile(settingsFile, 'utf8')); if (settings.scope === 'claude') scope = 'claude'; } catch { /* 首次运行或配置损坏时使用默认范围。 */ }
  const active = new Map();
  let ended = [], timer = null, inFlight = null, generation = 0, available = false, storageError = false;
  let sampleFailures = 0, failureSince = null, nextSampleAt = 0, nextFailureLogAt = 0, lastFailureCode = null;
  let historyDirty = false, temporary = null, storageRetry = null, storageFailures = 0, nextStorageLogAt = 0, flushTimer = null;
  const scheduleStorageRetry = scheduler.after ?? setTimeout;
  const cancelStorageRetry = scheduler.cancel ?? clearTimeout;
  function resetSamplingFailures() {
    sampleFailures = 0; failureSince = null; nextSampleAt = 0; nextFailureLogAt = 0; lastFailureCode = null;
  }
  let operation = Promise.resolve();
  const serialize = action => {
    const next = operation.then(action);
    operation = next.catch(() => {});
    return next;
  };
  const sortAt = record => Date.parse(record.endedAt ?? record.startedAt);
  const encode = records => JSON.stringify({ version: 1, records });
  function prune() {
    const cutoff = now() - retentionMs;
    const original = ended;
    ended = ended.filter(record => Date.parse(record.endedAt) > cutoff && (scope !== 'claude' || record.isClaude));
    for (const [id, item] of active) if (scope === 'claude' && !item.record.isClaude) active.delete(id);
    // 上限覆盖活动与结束记录，避免长连接无限占内存。计入 JSON 容器开销。
    const rows = [...ended, ...[...active.values()].map(item => item.record)].sort((a, b) => sortAt(a) - sortAt(b) || Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const sizes = rows.map(record => Buffer.byteLength(JSON.stringify(record)) + 1);
    let size = Buffer.byteLength(encode([])) + sizes.reduce((sum, value) => sum + value, 0);
    let remove = 0;
    while (remove < rows.length && (rows.length - remove > maxEntries || size > maxBytes)) size -= sizes[remove++];
    if (remove) {
      const ids = new Set(rows.slice(0, remove).map(record => record.id));
      ended = ended.filter(record => !ids.has(record.id));
      for (const id of ids) active.delete(id);
    }
    return original.length !== ended.length;
  }
  async function removeTemporary() {
    if (!temporary) return;
    await rm(temporary, { force: true });
    temporary = null;
  }
  async function writeHistory() {
    // 上次的临时文件仍被占用时，等下次重试再清理，避免连续生成大文件。
    await removeTemporary();
    // 轻量请求计数独立于 5MB/2万条的传输明细，普通 TLS 连接不能挤掉角标。
    pruneRequestCounts();
    if (await recoverRequestCounts() && (requestCounts.size || statsLoaded)) {
      await mkdir(stateDir, { recursive: true });
      temporary = `${requestStatsFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, buckets: [...requestCounts.values()] }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, requestStatsFile);
        statsLoaded = true;
        temporary = null;
      } finally { await removeTemporary().catch(() => {}); }
    }
    if (!ended.length) { await rm(file, { force: true }); return; }
    await mkdir(stateDir, { recursive: true });
    temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encode(ended), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      temporary = null;
    } finally { await removeTemporary().catch(() => {}); }
  }
  async function flushHistory(required = false) {
    if (!historyDirty || (storageRetry !== null && !required)) return;
    if (storageRetry !== null) {
      cancelStorageRetry(storageRetry);
      storageRetry = null;
    }
    try {
      await writeHistory();
    } catch (error) {
      storageError = true;
      const at = now();
      storageFailures++;
      const retryMs = Math.min(30000, 1000 * 2 ** Math.min(storageFailures - 1, 5));
      if (storageFailures === 1 || at >= nextStorageLogAt) {
        const code = ['EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'EROFS', 'ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code) ? error.code : 'UNKNOWN';
        logger(`[connection-log] 传输记录保存暂不可用（${code}，连续 ${storageFailures} 次，${retryMs}ms 后重试）。`);
        nextStorageLogAt = at + 30000;
      }
      const retry = scheduleStorageRetry(() => serialize(async () => {
        if (storageRetry !== retry) return;
        storageRetry = null;
        prune();
        await flushHistory();
      }), retryMs);
      storageRetry = retry;
      retry.unref?.();
      if (required) throw error;
      return;
    }
    historyDirty = false;
    storageError = false;
    if (storageFailures) logger(`[connection-log] 传输记录保存已恢复；连续失败 ${storageFailures} 次。`);
    storageFailures = 0;
  }
  function persist(required = false) {
    historyDirty = true;
    // 连接结束很频繁，全量快照每次重写会放大写盘并放大 rename 被占用（EPERM）的概率。
    // 生产环境合并到 storageDelayMs 一次；测试/显式刷新保持立即写。
    if (required || storageDelayMs <= 0) {
      if (flushTimer !== null) { cancelStorageRetry(flushTimer); flushTimer = null; }
      return flushHistory(required);
    }
    if (flushTimer !== null || storageRetry !== null) return Promise.resolve();
    flushTimer = scheduleStorageRetry(() => {
      flushTimer = null;
      void serialize(() => flushHistory()).catch(() => {});
    }, storageDelayMs);
    flushTimer.unref?.();
    return Promise.resolve();
  }
  // 上次异常退出可能留下整份快照临时文件；启动时清掉，避免状态目录持续膨胀。
  try {
    const prefixNames = [path.basename(file) + ".", path.basename(requestStatsFile) + "."];
    for (const name of await readdir(stateDir)) {
      if (prefixNames.some(prefix => name.startsWith(prefix)) && name.endsWith(".tmp")) await rm(path.join(stateDir, name), { force: true });
    }
  } catch { /* 状态目录不存在时忽略。 */ }
  let loadedHistory = false;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const unique = new Map();
    for (const item of Array.isArray(data.records) ? data.records : []) {
      const record = connectionRecord(item, now(), true);
      if (record?.endedAt && Date.parse(record.endedAt) >= Date.parse(record.startedAt) && Date.parse(record.endedAt) <= now() + 5000) unique.set(record.id, record);
    }
    ended = [...unique.values()];
    loadedHistory = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      storageError = true;
      logger('[connection-log] 传输记录读取失败；不影响网络连接。');
    }
  }
  // 统计文件存在时以它为准；仅迁移已有逐条出口证据的旧版本请求，不猜测历史归属。
  try {
    const buckets = parseRequestBuckets(await readFile(requestStatsFile, 'utf8'));
    for (const bucket of buckets) rememberRequest(bucket, bucket.count);
    statsLoaded = true;
  } catch (error) {
    // 仅首次缺失才允许迁移；临时不可读时保留原文件，避免用已裁剪明细覆盖完整计数。
    statsUnavailable = error.code !== 'ENOENT';
  }
  if (!statsLoaded && !statsUnavailable) for (const record of ended) if (record.kind === 'request' && record.isClaude) rememberRequest(record);
  if (loadedHistory) {
    prune();
    // 同时移除旧版本中不在白名单内的字段。
    await persist();
  }
  async function merge(payload, at) {
    if (!Array.isArray(payload) && (!payload || !Object.hasOwn(payload, 'connections') || (payload.connections !== null && !Array.isArray(payload.connections)))) {
      available = false;
      return;
    }
    const seen = new Set();
    const historical = new Map(ended.map(record => [record.id, record]));
    const resumed = new Set();
    let changed = false;
    for (const item of listConnections(payload)) {
      const record = connectionRecord(item, at);
      if (!record || (scope === 'claude' && !record.isClaude)) continue;
      seen.add(record.id);
      const current = active.get(record.id);
      const old = current?.record ?? historical.get(record.id);
      if (old) {
        record.startedAt = old.startedAt;
        record.upload = Math.max(old.upload, record.upload);
        record.download = Math.max(old.download, record.download);
        if (old.exitIp) record.exitIp = old.exitIp;
        if (!current) {
          // 同一 ID 再次出现（采样短暂缺失）合并回原连接。
          resumed.add(record.id);
          changed = true;
        }
      } else if (record.isClaude && record.route === 'proxied') {
        const exitIp = connectionExit(record, at);
        if (typeof exitIp === 'string' && isIP(exitIp)) record.exitIp = exitIp;
      }
      active.set(record.id, { record, misses: 0, missingAt: null });
    }
    if (resumed.size) ended = ended.filter(record => !resumed.has(record.id));
    for (const [id, item] of active) {
      if (item.record.kind === 'request' || seen.has(id)) continue;
      item.misses++;
      item.missingAt ??= new Date(at).toISOString();
      if (item.misses >= 2) {
        ended.push({ ...item.record, endedAt: item.missingAt });
        active.delete(id);
        changed = true;
      }
    }
    available = true;
    sampledAt = new Date(at).toISOString();
    if (prune() || changed) await persist();
  }
  function sample(payload, at = now()) { return serialize(() => merge(payload, at)); }
  function tick() {
    if (inFlight || !readConnections) return inFlight ?? Promise.resolve();
    if (now() < nextSampleAt) return Promise.resolve();
    const revision = generation;
    inFlight = (async () => {
      try {
        const payload = await readConnections();
        await serialize(async () => {
          if (revision !== generation) return;
          if (payload === null || payload === undefined) { available = false; resetSamplingFailures(); return; }
          await merge(payload, now());
          if (!available) throw Object.assign(new Error('无效连接快照。'), { code: 'INVALID_RESPONSE' });
          if (sampleFailures) logger(`[connection-log] 传输记录采样已恢复；连续失败 ${sampleFailures} 次，不可用 ${Math.max(0, now() - failureSince)}ms。`);
          resetSamplingFailures();
        });
      } catch (error) {
        if (revision !== generation) return;
        available = false;
        const at = now(), code = samplingErrorCode(error);
        sampleFailures++;
        failureSince ??= at;
        const retryMs = Math.min(30000, Math.max(1000, intervalMs) * 2 ** Math.min(sampleFailures, 5));
        nextSampleAt = at + retryMs;
        if (sampleFailures === 1 || at >= nextFailureLogAt || code !== lastFailureCode) {
          logger(`[connection-log] 传输记录采样暂不可用（${code}，连续 ${sampleFailures} 次，${retryMs}ms 后重试）；不影响流量转发。`);
          nextFailureLogAt = at + 30000;
          lastFailureCode = code;
        }
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  function start() {
    if (timer) return;
    timer = scheduler.every(tick, intervalMs);
    timer.unref?.();
    void tick();
  }
  async function stop() {
    if (timer) scheduler.clear(timer);
    timer = null;
    generation++;
    resetSamplingFailures();
    // 不等待网络请求；代次检查会丢弃它晚到的结果。
    return serialize(async () => {
      available = false;
      if (active.size) {
        const at = new Date(now()).toISOString();
        for (const item of active.values()) ended.push({ ...item.record, endedAt: at, ...(item.record.kind === 'request' ? { elapsedMs: Math.max(0, now() - Date.parse(item.record.startedAt)), error: 'STOPPED' } : {}) });
        active.clear();
        historyDirty = true;
      }
      if (prune()) historyDirty = true;
      // 内核停止后网关进程仍可存活，未完成的写盘可继续重试。
      await flushHistory(true);
    });
  }
  const transferRecords = () => [...ended, ...[...active.values()].map(item => item.record)];
  function queryRecords({ host = '', claude = false, viaExit = null, kind = 'all', at = null, route = 'all', state = 'all', exitIp = null } = {}) {
    const all = transferRecords().sort((a, b) => sortAt(b) - sortAt(a) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
    const needle = String(host).slice(0, 253).toLowerCase();
    const point = at === null ? null : Date.parse(at);
    if (point !== null && !Number.isFinite(point)) throw new Error('回放时间无效。');
    const filtered = all.filter(record => {
      if (exitIp !== null && (record.exitIp ?? 'unknown') !== exitIp) return false;
      const activeAt = point === null ? !record.endedAt : Date.parse(record.startedAt) <= point && (!record.endedAt || Date.parse(record.endedAt) > point);
      return (!needle || record.host.includes(needle) || record.ip?.toLowerCase().includes(needle)) && (!claude || record.isClaude) && (typeof viaExit !== 'boolean' || record.viaExit === viaExit) && (kind === 'all' || record.kind === kind) && (route === 'all' || record.route === route) && (state === 'all' || (state === 'active' ? activeAt : Boolean(record.endedAt) && !activeAt)) && (point === null || activeAt);
    });
    return { all, filtered, point };
  }
  function liveSnapshot() {
    const rows = available ? [...active.values()].filter(item => item.record.kind === 'connection' && item.misses === 0).map(item => item.record).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id)) : [];
    return { sampledAt, active: rows, activeTotal: rows.length, scope };
  }
  function list(query = {}) {
    return serialize(async () => {
      if (prune()) await persist();
      const { all, filtered, point } = queryRecords(query);
      const skip = Math.max(0, Math.trunc(Number(query.offset)) || 0), take = Math.max(1, Math.min(100, Math.trunc(Number(query.limit)) || 50));
      return structuredClone({ available, storageError, retentionHours: retentionMs / 3600000,
        ...liveSnapshot(), at: point === null ? null : new Date(point).toISOString(), exitIp: query.exitIp ?? null,
        stats: { active: active.size, ended: ended.length, total: all.length }, total: filtered.length, offset: skip, limit: take,
        items: filtered.slice(skip, skip + take), recent: all.slice(0, 3),
        detailId: query.detailId ?? null, selected: query.detailId ? all.find(record => record.id === query.detailId) ?? null : null,
      });
    });
  }
  function claudeCountsByExit() {
    return serialize(async () => {
      if (prune()) await persist();
      const byExit = {};
      let unassigned = 0;
      for (const record of transferRecords()) {
        if (!record.isClaude) continue;
        if (record.exitIp) byExit[record.exitIp] = (byExit[record.exitIp] ?? 0) + 1;
        else unassigned++;
      }
      return { byExit, unassigned };
    });
  }
  function beginRequest(info) {
    return serialize(async () => {
      const id = randomUUID();
      const exitIp = await Promise.resolve().then(() => requestExit(info)).catch(() => null);
      const record = connectionRecord({ id, kind: 'request', exitIp, method: info.method, endpoint: info.endpoint, metadata: { host: info.host, destinationPort: info.port }, start: new Date(now()).toISOString() }, now());
      active.set(id, { record, misses: 0, missingAt: null });
      rememberRequest(record);
      prune();
      await persist();
      return id;
    });
  }
  function finishRequest(id, result = {}) {
    return serialize(async () => {
      const item = active.get(id);
      if (!item || item.record.kind !== 'request') return;
      const record = connectionRecord({ ...item.record, ...result, exitIp: item.record.exitIp, id, kind: 'request', startedAt: item.record.startedAt, endedAt: new Date(now()).toISOString(), elapsedMs: Math.max(0, now() - Date.parse(item.record.startedAt)) }, now(), true);
      active.delete(id);
      ended.push(record);
      prune();
      await persist();
    });
  }
  function updateRequest(id, result = {}) {
    return serialize(async () => {
      const item = active.get(id);
      if (!item || item.record.kind !== 'request') return;
      item.record = connectionRecord({ ...item.record, status: result.status ?? item.record.status, upload: Math.max(item.record.upload, bytes(result.upload)), download: Math.max(item.record.download, bytes(result.download)), elapsedMs: Math.max(0, now() - Date.parse(item.record.startedAt)) }, now(), true);
      if (prune()) await persist();
    });
  }
  function setScope(next) {
    return serialize(async () => {
      if (!['all', 'claude'].includes(next)) throw new Error('记录范围无效。');
      // 先保存已筛过的历史，避免重启时恢复尚未从磁盘移除的旧记录。
      if (scope === 'claude' && next === 'all') await flushHistory(true);
      const temporary = `${settingsFile}.${randomUUID()}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true });
        await writeFile(temporary, JSON.stringify({ scope: next }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, settingsFile);
        scope = next;
        if (prune() || next === 'claude') historyDirty = true;
        generation++;
        resetSamplingFailures();
        await flushHistory(true);
        return { scope };
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
  }
  function exportRecords(query = {}, format = 'json') {
    return serialize(async () => {
      if (prune()) await persist();
      const { filtered } = queryRecords(query);
      if (format === 'json') return JSON.stringify({ version: 1, exportedAt: new Date(now()).toISOString(), retentionHours: retentionMs / 3600000, scope, at: query.at ?? null, records: filtered }, null, 2);
      if (format !== 'csv') throw new Error('导出格式无效。');
      const fields = ['id', 'kind', 'host', 'ip', 'port', 'chains', 'rule', 'rulePayload', 'upload', 'download', 'startedAt', 'endedAt', 'isClaude', 'viaExit', 'method', 'endpoint', 'status', 'elapsedMs', 'error', 'exitIp'];
      const cell = value => {
        let text = Array.isArray(value) ? value.join(' → ') : String(value ?? '');
        if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      };
      return '\ufeff' + [fields.map(cell).join(','), ...filtered.map(record => fields.map(field => cell(record[field])).join(','))].join('\r\n');
    });
  }
  function clear() {
    return serialize(async () => {
      // 串行清空与写盘，并让清空前发出的采样失效，防止旧结果复活。
      generation++;
      resetSamplingFailures();
      active.clear();
      ended = [];
      requestCounts.clear();
      statsLoaded = true;
      statsUnavailable = false;
      await persist(true);
      return { cleared: true };
    });
  }
  const snapshot = async () => {
    const { available, storageError, retentionHours, stats, recent, sampledAt, active, activeTotal, scope } = await list({ limit: 3 });
    return { available, storageError, retentionHours, stats, recent, sampledAt, active, activeTotal, scope };
  };
  /** 按开始时间统计已结束记录与 HTTP 请求；时间重合不能证明使用了某个出口 IP。 */
  function countsByWindows(windows = []) {
    return windows.map(window => {
      const from = Date.parse(window.from), to = Date.parse(window.to);
      let connections = 0, requests = 0;
      for (const record of ended) {
        const at = Date.parse(record.startedAt);
        if (at >= from && at < to) { connections++; if (record.kind === 'request') requests++; }
      }
      return { connections, requests };
    });
  }
  function requestCountsByExit() {
    return serialize(async () => {
      if (!await recoverRequestCounts()) return null;
      pruneRequestCounts();
      const byExit = Object.create(null);
      let unassigned = 0;
      for (const record of requestCounts.values()) {
        if (record.exitIp) byExit[record.exitIp] = (byExit[record.exitIp] ?? 0) + record.count;
        else unassigned += record.count;
      }
      return { byExit: { ...byExit }, unassigned };
    });
  }
  // 显式落盘：用于退出前或需要立即读取磁盘快照的调用方。
  function flush() {
    if (flushTimer !== null) { cancelStorageRetry(flushTimer); flushTimer = null; }
    return serialize(() => flushHistory(true));
  }
  return { start, stop, tick, sample, list, claudeCountsByExit, flush, countsByWindows, requestCountsByExit, clear, snapshot, beginRequest, updateRequest, finishRequest, setScope, settings: () => ({ scope }), export: exportRecords };
}
