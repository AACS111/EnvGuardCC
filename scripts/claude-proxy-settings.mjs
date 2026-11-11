import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// 崩溃后配置里可能留着 EGCC 自己的代理；它既不能当用户原值保存，也不能在恢复时写回去。
function isOwnProxy(value, proxy) {
  if (typeof value !== 'string') return false;
  try {
    const saved = new URL(value), own = new URL(proxy);
    return saved.origin === own.origin && saved.pathname === '/' && !saved.search && !saved.hash;
  } catch { return false; }
}

async function readObject(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!isObject(value)) throw new Error('Claude 代理配置必须是 JSON 对象。');
  return value;
}

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function createClaudeProxySettings({ stateDir, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude') }) {
  const settingsFile = path.resolve(configDir, 'settings.json');
  const backupFile = path.join(stateDir, 'claude-proxy-backup.json');
  let queue = Promise.resolve();
  const serialize = action => (...args) => {
    const pending = queue.then(() => action(...args));
    queue = pending.catch(() => {});
    return pending;
  };

  async function readBackup() {
    const backup = await readObject(backupFile);
    if (backup && (backup.version !== 1 || backup.settingsFile !== settingsFile ||
      typeof backup.hadFile !== 'boolean' || typeof backup.hadEnv !== 'boolean' || !isObject(backup.entries) ||
      Object.entries(backup.entries).some(([key, entry]) => !proxyKeys.includes(key) || !isObject(entry) ||
        typeof entry.had !== 'boolean' || !Object.hasOwn(entry, 'value') || !Array.isArray(entry.applied) ||
        !entry.applied.length || entry.applied.some(value => typeof value !== 'string')))) {
      throw new Error('Claude 代理原始备份无效，已保留配置和备份。');
    }
    return backup;
  }

  function checkEnv(settings) {
    if (Object.hasOwn(settings, 'env') && !isObject(settings.env)) throw new Error('Claude 配置的 env 必须是 JSON 对象。');
  }

  async function apply(proxy) {
    const url = new URL(proxy);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Claude 代理必须使用 EGCC 的本机 HTTP 代理端口。');
    }
    const current = await readObject(settingsFile);
    const settings = current ?? {};
    checkEnv(settings);
    const backup = await readBackup() ?? {
      version: 1, settingsFile, hadFile: current !== null, hadEnv: Object.hasOwn(settings, 'env'), entries: {},
    };
    const env = settings.env ?? {};
    for (const key of proxyKeys) {
      if (!['HTTP_PROXY', 'HTTPS_PROXY'].includes(key) && !Object.hasOwn(env, key) && !Object.hasOwn(backup.entries, key)) continue;
      const saved = backup.entries[key];
      const current = env[key];
      if (!saved || !saved.applied.includes(current)) {
        // 上次崩溃没来得及恢复时，环境里留着的是 EGCC 自己的代理，记为“本来没有”，恢复时删除。
        backup.entries[key] = isOwnProxy(current, proxy)
          ? { had: false, value: null, applied: [proxy] }
          : { had: Object.hasOwn(env, key), value: current ?? null, applied: [proxy] };
      } else if (!saved.applied.includes(proxy)) saved.applied.push(proxy);
      env[key] = proxy;
    }
    // 先保存原值，写入失败或异常退出后仍可恢复。
    await save(backupFile, backup);
    settings.env = env;
    await save(settingsFile, settings);
  }

  async function restore() {
    const backup = await readBackup();
    if (!backup) return;
    const settings = await readObject(settingsFile);
    if (settings) {
      checkEnv(settings);
      let changed = false;
      for (const [key, entry] of Object.entries(backup.entries)) {
        if (!settings.env || !entry.applied.includes(settings.env[key])) continue;
        // 旧版备份可能把 EGCC 自己的代理记成了原值；恢复成死端口等于再次断网。
        if (entry.had && !entry.applied.some(applied => isOwnProxy(entry.value, applied))) settings.env[key] = entry.value;
        else delete settings.env[key];
        changed = true;
      }
      if (changed) {
        if (!backup.hadEnv && Object.keys(settings.env).length === 0) delete settings.env;
        if (!backup.hadFile && Object.keys(settings).length === 0) await rm(settingsFile);
        else await save(settingsFile, settings);
      }
    }
    await rm(backupFile, { force: true });
  }

  return { apply: serialize(apply), restore: serialize(restore) };
}
