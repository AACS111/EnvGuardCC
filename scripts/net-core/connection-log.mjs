// 只记录本机内核连接元数据。活动连接仅在内存，结束记录原子写入 state 目录。
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
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
  return {
    id: value.id, kind: value.kind === 'request' ? 'request' : 'connection', host, ip: typeof ip === 'string' && isIP(ip) ? ip : null,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    chains, rule: label(value.rule), rulePayload: label(value.rulePayload),
    upload: bytes(value.upload), download: bytes(value.download),
    startedAt: start && Date.parse(start) <= at ? start : new Date(at).toISOString(),
    endedAt: saved ? timestamp(value.endedAt) : null,
    isClaude: value.kind === 'request' || isClaudeHost(host), route, viaExit: route === 'unknown' ? null : route === 'proxied',
    ...(value.kind === 'request' ? {
      method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value.method) ? value.method : 'OTHER',
      endpoint: requestEndpoint(value.endpoint),
      status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
      elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? Math.round(value.elapsedMs) : null,
      error: ['UPSTREAM_ERROR', 'CLIENT_ABORTED', 'STREAM_ERROR', 'STOPPED'].includes(value.error) ? value.error : null,
    } : {}),
  };
}

export async function createConnectionLog({ stateDir, readConnections, now = Date.now, logger = () => {},
  scheduler = { every: setInterval, clear: clearInterval }, intervalMs = 1000,
  retentionMs = CONNECTION_RETENTION_MS, maxEntries = CONNECTION_MAX_ENTRIES, maxBytes = CONNECTION_MAX_BYTES,
} = {}) {
  const file = path.join(stateDir, 'net-core-connections.json');
  const settingsFile = path.join(stateDir, 'net-core-connection-settings.json');
  let scope = 'all', sampledAt = null;
  try { const settings = JSON.parse(await readFile(settingsFile, 'utf8')); if (settings.scope === 'claude') scope = 'claude'; } catch { /* 首次运行或配置损坏时使用默认范围。 */ }
  const active = new Map();
  let ended = [], timer = null, inFlight = null, generation = 0, available = false, storageError = false, reportedFailure = false;
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
    let changed = original.length !== ended.length;
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
      changed = true;
    }
    return changed;
  }
  async function persist() {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      if (!ended.length) await rm(file, { force: true });
      else {
        await mkdir(stateDir, { recursive: true });
        await writeFile(temporary, encode(ended), { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      }
      storageError = false;
    } catch (error) { storageError = true; throw error; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const unique = new Map();
    for (const item of Array.isArray(data.records) ? data.records : []) {
      const record = connectionRecord(item, now(), true);
      if (record?.endedAt && Date.parse(record.endedAt) >= Date.parse(record.startedAt) && Date.parse(record.endedAt) <= now() + 5000) unique.set(record.id, record);
    }
    ended = [...unique.values()];
    prune();
    // 同时移除旧版本中不在白名单内的字段。
    await persist();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      storageError = true;
      logger('[connection-log] 传输记录读取失败；不影响网络连接。');
    }
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
      if (current) {
        record.startedAt = current.record.startedAt;
        record.upload = Math.max(current.record.upload, record.upload);
        record.download = Math.max(current.record.download, record.download);
      } else {
        // 同一 ID 再次出现（采样短暂缺失）合并回原连接。
        const old = historical.get(record.id);
        if (old) {
          record.startedAt = old.startedAt;
          record.upload = Math.max(old.upload, record.upload);
          record.download = Math.max(old.download, record.download);
          resumed.add(record.id);
          changed = true;
        }
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
    if (prune() || changed || storageError) await persist();
  }
  function sample(payload, at = now()) { return serialize(() => merge(payload, at)); }
  function tick() {
    if (inFlight || !readConnections) return inFlight ?? Promise.resolve();
    const revision = generation;
    inFlight = (async () => {
      try {
        const payload = await readConnections();
        await serialize(async () => {
          if (revision !== generation) return;
          if (payload === null || payload === undefined) { available = false; return; }
          await merge(payload, now());
          reportedFailure = false;
        });
      } catch {
        if (revision === generation) available = false;
        if (!reportedFailure) logger('[connection-log] 传输记录采样暂不可用；等待下一轮。');
        reportedFailure = true;
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
    // 不等待网络请求；代次检查会丢弃它晚到的结果。
    return serialize(async () => {
      available = false;
      if (!active.size) { if (prune()) await persist(); return; }
      const at = new Date(now()).toISOString();
      for (const item of active.values()) ended.push({ ...item.record, endedAt: at, ...(item.record.kind === 'request' ? { elapsedMs: Math.max(0, now() - Date.parse(item.record.startedAt)), error: 'STOPPED' } : {}) });
      active.clear();
      prune();
      await persist();
    });
  }
  function queryRecords({ host = '', claude = false, viaExit = null, kind = 'all', at = null, route = 'all', state = 'all' } = {}) {
    const all = [...ended, ...[...active.values()].map(item => item.record)].sort((a, b) => sortAt(b) - sortAt(a) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
    const needle = String(host).slice(0, 253).toLowerCase();
    const point = at === null ? null : Date.parse(at);
    if (point !== null && !Number.isFinite(point)) throw new Error('回放时间无效。');
    const filtered = all.filter(record => {
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
        ...liveSnapshot(), at: point === null ? null : new Date(point).toISOString(),
        stats: { active: active.size, ended: ended.length, total: all.length }, total: filtered.length, offset: skip, limit: take,
        items: filtered.slice(skip, skip + take), recent: all.slice(0, 3),
        detailId: query.detailId ?? null, selected: query.detailId ? all.find(record => record.id === query.detailId) ?? null : null,
      });
    });
  }
  function beginRequest(info) {
    return serialize(async () => {
      const id = randomUUID();
      const record = connectionRecord({ id, kind: 'request', method: info.method, endpoint: info.endpoint, metadata: { host: info.host, destinationPort: info.port }, start: new Date(now()).toISOString() }, now());
      active.set(id, { record, misses: 0, missingAt: null });
      if (prune()) await persist();
      return id;
    });
  }
  function finishRequest(id, result = {}) {
    return serialize(async () => {
      const item = active.get(id);
      if (!item || item.record.kind !== 'request') return;
      const record = connectionRecord({ ...item.record, ...result, id, kind: 'request', startedAt: item.record.startedAt, endedAt: new Date(now()).toISOString(), elapsedMs: Math.max(0, now() - Date.parse(item.record.startedAt)) }, now(), true);
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
      const temporary = `${settingsFile}.${randomUUID()}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true });
        await writeFile(temporary, JSON.stringify({ scope: next }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, settingsFile);
        scope = next;
        prune();
        await persist();
        generation++;
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
      const fields = ['id', 'kind', 'host', 'ip', 'port', 'chains', 'rule', 'rulePayload', 'upload', 'download', 'startedAt', 'endedAt', 'isClaude', 'viaExit', 'method', 'endpoint', 'status', 'elapsedMs', 'error'];
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
      active.clear();
      ended = [];
      await persist();
      return { cleared: true };
    });
  }
  const snapshot = async () => {
    const { available, storageError, retentionHours, stats, recent, sampledAt, active, activeTotal, scope } = await list({ limit: 3 });
    return { available, storageError, retentionHours, stats, recent, sampledAt, active, activeTotal, scope };
  };
  return { start, stop, tick, sample, list, clear, snapshot, beginRequest, updateRequest, finishRequest, setScope, settings: () => ({ scope }), export: exportRecords };
}
