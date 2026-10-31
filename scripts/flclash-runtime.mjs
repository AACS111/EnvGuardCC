import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const exec = promisify(execFile);
export function flclashDirectory({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.CHECKCC_FLCLASH_DIR) return path.resolve(env.CHECKCC_FLCLASH_DIR);
  return platform === 'darwin' ? path.join(home, 'Library/Application Support/com.follow.clash') : path.join(env.APPDATA || '', 'com.follow/clash');
}

export function profileIdFromPreferences(raw) {
  const id = raw.match(/"currentProfileId"\s*:\s*(?:"(\d+)"|(\d+))/);
  if (!id) throw new Error('FlClash 尚未选择配置，请先在 FlClash 中导入并选择配置。');
  return id[1] || id[2];
}

async function preferencesRaw({ directory = flclashDirectory(), platform = process.platform, run = exec } = {}) {
  let raw;
  try {
    const preferences = JSON.parse(await readFile(path.join(directory, 'shared_preferences.json'), 'utf8'));
    raw = preferences['flutter.config'] || preferences.config;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (platform !== 'darwin') throw new Error('未找到 FlClash 配置目录，请先运行 FlClash。');
    try { raw = (await run('/usr/bin/defaults', ['read', 'com.follow.clash', 'flutter.config'], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch { throw new Error('尚未读取到 FlClash 当前配置，请先在 FlClash 中选择配置。'); }
  }
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export async function currentFlclashProfile({ directory = flclashDirectory(), platform = process.platform, env = process.env, run = exec } = {}) {
  if (env.CHECKCC_FLCLASH_PROFILE) { const file = path.resolve(env.CHECKCC_FLCLASH_PROFILE); await access(file); return file; }
  const raw = await preferencesRaw({ directory, platform, run });
  const file = path.join(directory, 'profiles', `${profileIdFromPreferences(raw || '')}.yaml`);
  await access(file);
  return file;
}

export async function flclashController(directory = flclashDirectory()) {
  const file = path.join(directory, 'config.yaml');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch { throw new Error('未找到 FlClash 运行配置，请先启动 FlClash 内核。'); }
  const config = yaml.load(raw);
  let address = config?.['external-controller'], secret = config?.secret;
  // config.yaml is written only on apply; the running core may already have the controller.
  if (typeof address !== 'string' || !address || !secret) {
    try {
      const patch = JSON.parse(await preferencesRaw({ directory })).patchClashConfig ?? {};
      address = address || patch['external-controller'];
      secret = secret || patch.secret;
    } catch { /* keep config.yaml values and report below */ }
  }
  if (typeof address !== 'string' || !address) throw new Error('请在 FlClash 开启仅本机、带认证的外部控制，并重新应用一次配置后重试。');
  let url;
  try { url = new URL(`http://${address}`); } catch { throw new Error('FlClash 外部控制地址无效。'); }
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !secret) throw new Error('FlClash 外部控制必须限于本机、指定端口并设置认证。');
  return { file, raw, config, url, secret: String(secret) };
}

export async function controllerRequest(controller, route, body) {
  let response;
  try { response = await fetch(new URL(route, controller.url), {
    method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${controller.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  }); } catch (error) { throw new Error('FlClash 控制接口连接失败，请确认内核已运行且本机控制地址可用。', { cause: error }); }
  if (!response.ok) throw new Error(`FlClash 内核操作失败（HTTP ${response.status}），原始备份已保留。`);
  return response.status === 204 ? null : response.json();
}

