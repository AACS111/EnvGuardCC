import { readFile, writeFile, mkdir, mkdtemp, rename, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { buildTrafficConfig } from './traffic-rules.mjs';
import { currentFlclashProfile, flclashController, controllerRequest } from './flclash-runtime.mjs';
import { hasTrafficEndpoints, hasTrafficReferences, planTrafficRecovery } from './traffic-recovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.CHECKCC_STATE_DIR ?? path.join(root, 'node_modules/.check-cc-local');
const stateFile = path.join(state, 'traffic-layer.json');
const pendingFile = path.join(state, 'traffic-layer.prepared.json');
const settingsFile = path.join(state, 'traffic-settings.json');
const appliedFile = path.join(state, 'traffic-applied-profile.yaml');
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async file => { try { await access(file); return true; } catch { return false; } };
async function atomic(file, value) { const temp = `${file}.checkcc-tmp`; await writeFile(temp, value, {mode:0o600}); await rename(temp,file); }
const profilePath = () => currentFlclashProfile();
export const entryStatus = async config => {
  const auth = `Basic ${Buffer.from(`${config.routes[0]?.id}:${config.secret}`).toString('base64')}`;
  const response = await fetch(`http://127.0.0.1:${config.listenPort}/__checkcc/traffic/status`, { headers: { 'Proxy-Authorization': auth }, signal: AbortSignal.timeout(2000) });
  const result = await response.json();
  if (!response.ok || result.kind !== 'checkcc-traffic-layer' || result.version !== 1) throw new Error('拦截入口未验证，拒绝应用。');
  return result;
};
const returnPortStates = config => Promise.all(config.routes.map(route => new Promise(resolve => {
  const socket = net.connect(Number(new URL(route.upstream).port), '127.0.0.1');
  socket.setTimeout(1000);
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done('open'));
  socket.once('error', error => done(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  socket.once('timeout', () => done('unknown'));
})));
const recoveryError = (code, message) => Object.assign(new Error(message), { code });

async function recoveryPlan(config) {
  let current;
  try { current = await readFile(config.profile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw recoveryError('FLCLASH_CONFLICT', '原联动配置文件已不存在，请在 FlClash 中检查配置后重试。'); throw error; }
  let original;
  try { original = await readFile(path.join(state, 'traffic-original-profile.yaml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!original || hash(original) !== config.originalHash) {
    return { kind: 'conflict', reason: '联动前备份缺失或已变化，无法自动恢复。请查看备份并手动检查。', current, original, fingerprint: hash(current), originalValid: false };
  }
  let applied;
  for (const file of [appliedFile, path.join(state, 'traffic-prepared-profile.yaml')]) {
    try { const raw = await readFile(file, 'utf8'); if (hash(raw) === config.appliedHash) { applied = raw; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!applied && hash(current) === config.appliedHash) applied = current;
  const plan = planTrafficRecovery({ originalRaw: original, appliedRaw: applied, currentRaw: current, config });
  return { ...plan, current, original, applied, fingerprint: hash(current), originalValid: true };
}

async function backupRecovery(config, plan) {
  if (config.recoveryHash === plan.fingerprint && config.recoveryBackup && await exists(config.recoveryBackup)) return;
  await mkdir(state, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(state, 'traffic-recovery-'));
  const save = (name, value) => writeFile(path.join(directory, name), value, { flag: 'wx', mode: 0o600 });
  await Promise.all([
    save('current-profile.yaml', plan.current),
    ...(plan.original ? [save('original-profile.yaml', plan.original)] : []),
    save('traffic-state.json', JSON.stringify(config, null, 2)),
    ...(plan.applied ? [save('applied-profile.yaml', plan.applied)] : []),
  ]);
  config.recoveryBackup = directory;
  config.recoveryHash = plan.fingerprint;
  await atomic(stateFile, JSON.stringify(config, null, 2));
}

async function verifyRestoredRuntime(config) {
  let selected, current, proxies, rules, ports;
  try {
    selected = await profilePath();
    current = await readFile(selected, 'utf8');
    const selectedProfile = yaml.load(current);
    if (hasTrafficReferences(selectedProfile) || hasTrafficEndpoints(selectedProfile, config)) {
      throw recoveryError('FLCLASH_CONFLICT', 'FlClash 当前选中的配置仍包含 EnvGuardCC 联动，请先处理该配置后重试。');
    }
    const controller = await flclashController();
    if (hasTrafficReferences(controller.config) || hasTrafficEndpoints(controller.config, config)) {
      throw recoveryError('FLCLASH_RELOAD_REQUIRED', 'FlClash 运行配置仍包含联动入口，请重新应用当前配置后检查并退出。');
    }
    [proxies, rules, ports] = await Promise.all([
      controllerRequest(controller, '/proxies'), controllerRequest(controller, '/rules'), returnPortStates(config),
    ]);
    if (!proxies?.proxies || typeof proxies.proxies !== 'object' || !Array.isArray(rules?.rules)) throw new Error('控制器返回的状态不完整。');
  } catch (error) {
    if (error.code === 'FLCLASH_CONFLICT' || error.code === 'FLCLASH_RELOAD_REQUIRED') throw error;
    throw recoveryError('FLCLASH_VERIFY_REQUIRED', '无法核验 FlClash 运行状态。请打开 FlClash，启动内核并确认本机控制器可用，然后重新检查。');
  }
  if (hasTrafficReferences(proxies.proxies) || hasTrafficReferences(rules.rules) || ports.includes('open')) {
    throw recoveryError('FLCLASH_RELOAD_REQUIRED', '配置已处理。请在 FlClash 重新应用当前配置，再点击“检查并退出”；期间请保持 EnvGuardCC 运行。');
  }
  if (ports.includes('unknown')) throw recoveryError('FLCLASH_VERIFY_REQUIRED', '无法确认回程端口状态，请检查 FlClash 后重试。');
  if (selected !== await profilePath() || hash(await readFile(selected, 'utf8')) !== hash(current)) {
    throw recoveryError('FLCLASH_VERIFY_REQUIRED', '核验期间 FlClash 配置发生变化，请重新检查。');
  }
}
export async function trafficStatus() {
  let saved = null;
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let groups = [], detail, available = false;
  try {
    const profile = yaml.load(await readFile(await profilePath(), 'utf8'));
    groups = (profile['proxy-groups'] || []).filter(group => !group.name.startsWith('EnvGuardCC-')).map(group => group.name);
    available = true; detail = saved?.applied ? '联动配置已写入，正在核对内核和入口。' : '未应用联动；先选择回程策略并准备配置。';
  } catch (error) { detail = error.message; }
  let controllerReady = process.platform !== 'darwin';
  if (available && process.platform === 'darwin') {
    try { await controllerRequest(await flclashController(), '/version'); controllerReady = true; } catch (error) { detail = error.message; }
  }
  let stats, runtimeVerified = false;
  if (saved?.applied) {
    try {
      stats = (await entryStatus(saved)).stats;
      const controller = await flclashController();
      const result = await controllerRequest(controller, '/proxies');
      runtimeVerified = saved.routes.every(route => result.proxies?.[`EnvGuardCC-${route.id}`]) && (await returnPortStates(saved)).every(value => value === 'open');
      detail = saved.phase === 'restore_pending' ? '配置已处理；请在 FlClash 重新应用当前配置，再检查恢复状态。' : runtimeVerified ? 'FlClash 已加载联动策略与回程入口；实际覆盖以转发计数及目标连接验证为准。' : '请在 FlClash 重新应用并启动当前配置（确认内核处于运行状态），再刷新连接状态核验回程入口。';
    } catch (error) { detail = error.message; }
  }
  let recovery;
  if (saved?.applied) {
    try {
      const plan = await recoveryPlan(saved);
      const kind = saved.phase === 'restore_pending' && plan.kind === 'clean' ? 'reload' : plan.fingerprint === saved.appliedHash && saved.phase !== 'restore_pending' && plan.originalValid ? 'ready' : plan.kind;
      recovery = { kind, reason: plan.reason, changes: plan.changes, fingerprint: plan.fingerprint, backupDir: saved.recoveryBackup, originalValid: plan.originalValid };
    } catch (error) { recovery = { kind: 'conflict', reason: error.message, backupDir: saved.recoveryBackup }; }
  }
  return { available, prepared: Boolean(saved && await exists(pendingFile)), controllerReady, applied: Boolean(saved?.applied), phase: saved?.phase, runtimeVerified, groups, defaultPolicy: saved?.defaultPolicy, detail, stats, recovery };
}

export async function prepareTrafficConfig(options = {}) {
  await mkdir(state,{recursive:true});
  if (!(await exists(settingsFile))) await atomic(settingsFile, JSON.stringify({listenPort:3011,upstreamBasePort:39100,defaultPolicy:'Overseas',allOverseas:true,sites:{domains:['claude.ai','anthropic.com'],ips:[],cidrs:[]}},null,2));
  const settings = JSON.parse(await readFile(settingsFile,'utf8'));
  if (options.defaultPolicy !== undefined) {
    if (typeof options.defaultPolicy !== 'string' || !options.defaultPolicy.trim()) throw new Error('请选择回程策略组。');
    settings.defaultPolicy = options.defaultPolicy;
    await atomic(settingsFile, JSON.stringify(settings, null, 2));
  }
  if (settings.allOverseas !== true) throw new Error('当前版本要求所有海外代理策略经过拦截层');
  const profile = await profilePath(), backup = path.join(state,'traffic-original-profile.yaml');
  let previous = null;
  if (await exists(stateFile)) previous = JSON.parse(await readFile(stateFile,'utf8'));
  if(previous?.applied && (previous.listenPort!==settings.listenPort || Number(new URL(previous.routes[0].upstream).port)!==settings.upstreamBasePort)) throw new Error('已运行时不能直接更换监听端口，请先恢复后重新配置');
  if (previous?.applied && previous.profile && previous.profile !== profile) throw new Error('FlClash 已切换订阅，请先恢复旧配置再准备新配置');
  const current = await readFile(profile,'utf8');
  const original = previous?.applied ? await readFile(backup,'utf8') : current;
  if (previous?.applied && hash(current) !== previous.appliedHash) throw new Error('FlClash 配置已被外部更新；请先核对变化，不覆盖新的订阅');
  const secret = previous?.secret ?? randomBytes(32).toString('hex');
  const built = buildTrafficConfig(yaml.load(original), {...settings,secret});
  const generated = yaml.dump(built.config,{lineWidth:-1,noRefs:true});
  const prepared = {...built,config:undefined,allOverseas:true,profile,originalHash:hash(original),generatedHash:hash(generated),applied:previous?.applied??false,appliedHash:previous?.appliedHash};
  if (!previous?.applied) await atomic(backup,original);
  await atomic(path.join(state,'traffic-prepared-profile.yaml'),generated);
  await atomic(pendingFile,JSON.stringify(prepared,null,2));
  if(!previous?.applied) await atomic(stateFile,JSON.stringify(prepared,null,2));
  console.log(JSON.stringify({state:'prepared',routes:built.routes.map(({id,policy,upstream})=>({id,policy,upstream})),sites:built.sites,settingsFile,profile,config:path.join(state,'traffic-prepared-profile.yaml')}));
  return prepared;
}

export async function applyTrafficConfig() {
  const config = JSON.parse(await readFile(await exists(pendingFile)?pendingFile:stateFile,'utf8'));
  const current = await readFile(config.profile,'utf8');
  if (hash(current) !== (config.applied ? config.appliedHash : config.originalHash)) throw new Error('原配置发生变化，拒绝覆盖');
  await entryStatus(config);
  const generated = await readFile(path.join(state,'traffic-prepared-profile.yaml'),'utf8');
  if (hash(generated) !== config.generatedHash) throw new Error('待应用配置已被修改，请重新准备');
  if (process.platform === 'darwin') {
    const controller = await flclashController();
    await controllerRequest(controller, '/version');
  }
  if(process.platform==='win32') {
    const startup=path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup/EnvGuardCC Traffic Layer.vbs');
    const quote=value=>value.replaceAll('"','""');
    const source=`Set shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & "${quote(process.execPath)}" & Chr(34) & " " & Chr(34) & "${quote(path.join(root,'scripts/traffic-layer.mjs'))}" & Chr(34) & " " & Chr(34) & "${quote(stateFile)}" & Chr(34), 0, False\r\n`;
    if(await exists(startup) && hash(await readFile(startup,'utf8'))!==hash(source)) throw new Error('自启动入口已有其他内容，拒绝覆盖');
    await atomic(startup,source);config.startup={file:startup,hash:hash(source)};
  }
  await atomic(appliedFile, generated);
  await atomic(config.profile,generated);
  config.applied=true;config.appliedHash=hash(generated);
  config.phase = process.platform === 'darwin' ? 'awaiting_reload' : 'applied';
  await atomic(stateFile,JSON.stringify(config,null,2));
  await atomic(pendingFile,JSON.stringify(config,null,2));
  console.log('已写入联动配置；请在 FlClash 重新应用并启动当前配置，再核验回程端口与真实流量。');
}
export async function restoreTrafficConfig({ mode = 'normal', expectedHash } = {}) {
  const config = JSON.parse(await readFile(stateFile,'utf8'));
  if (!config.applied) {console.log('未应用，无需恢复');return;}
  if (!['normal', 'preserve', 'original'].includes(mode)) throw new Error('无效的恢复方式。');
  const plan = await recoveryPlan(config);
  if (mode !== 'normal' && (!expectedHash || expectedHash !== plan.fingerprint)) throw recoveryError('FLCLASH_CONFLICT', '配置在确认后发生变化，请重新查看并重试。');
  let replacement;
  if (mode === 'original') {
    if (!plan.originalValid) throw recoveryError('FLCLASH_CONFLICT', '联动前备份不可用，不能覆盖当前配置。');
    replacement = plan.original;
  }
  else if (mode === 'preserve') {
    if (plan.kind !== 'merge') throw recoveryError('FLCLASH_CONFLICT', plan.reason || '当前配置不需要此恢复方式，请重新检查。');
    replacement = plan.candidate;
  } else if (plan.originalValid && plan.fingerprint === config.appliedHash && config.phase !== 'restore_pending') replacement = plan.original;
  else if (plan.kind !== 'clean') {
    await backupRecovery(config, plan);
    throw recoveryError(plan.kind === 'merge' ? 'FLCLASH_MERGE_AVAILABLE' : 'FLCLASH_CONFLICT', plan.kind === 'merge'
      ? 'FlClash 配置已变化。可保留现有修改并解除联动；当前配置和原始备份已保存。'
      : `${plan.reason} 当前配置和原始备份已保存。`);
  }
  if (replacement !== undefined && replacement !== plan.current) {
    await backupRecovery(config, plan);
    if (hash(await readFile(config.profile, 'utf8')) !== plan.fingerprint) throw recoveryError('FLCLASH_CONFLICT', '配置在恢复期间发生变化，未覆盖；请重新检查。');
    await atomic(config.profile, replacement);
  }
  config.phase = 'restore_pending';
  config.restoreHash = hash(await readFile(config.profile, 'utf8'));
  await atomic(stateFile, JSON.stringify(config, null, 2));
  await verifyRestoredRuntime(config);
  if (hash(await readFile(config.profile, 'utf8')) !== config.restoreHash) throw recoveryError('FLCLASH_VERIFY_REQUIRED', '核验期间配置发生变化，请重新检查。');
  if(config.startup && await exists(config.startup.file) && hash(await readFile(config.startup.file,'utf8'))===config.startup.hash) await unlink(config.startup.file);
  config.applied=false;config.phase='restored';delete config.appliedHash;delete config.restoreHash;
  await atomic(stateFile,JSON.stringify(config,null,2));
  if(await exists(pendingFile)) await unlink(pendingFile);
  console.log('FlClash 配置与回程入口已核验恢复。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command=process.argv[2]??'prepare';
    if(command==='prepare') await prepareTrafficConfig();
    else if(command==='apply') await applyTrafficConfig();
    else if(command==='restore') await restoreTrafficConfig();
    else if(command==='status') {
      const c=JSON.parse(await readFile(stateFile,'utf8'));
      console.log(JSON.stringify({applied:c.applied,listenPort:c.listenPort,sites:c.sites,routes:c.routes.map(({id,policy,upstream})=>({id,policy,upstream})),settingsFile}));
    } else throw new Error('支持 prepare / apply / restore / status');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
