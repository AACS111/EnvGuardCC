import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocol } from './protocol.mjs';
import { closeServer, startSite } from './site.mjs';
import { createShutdown } from './lifecycle.mjs';
import { createDesktopSettings } from '../scripts/desktop-settings.mjs';
import { createClaudeReset } from '../scripts/claude-reset.mjs';

console.log = console.info = console.debug = console.error;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devURL = process.env.CHECKCC_DESKTOP_DEV_URL;
let origin = 'http://127.0.0.1:3030';
if (devURL && new URL(devURL).origin !== origin) throw new Error('开发页面必须使用 ' + origin);
if (!process.env.CHECKCC_DESKTOP_USER_DATA) throw new Error('缺少桌面用户数据目录。');
process.env.CHECKCC_STATE_DIR ||= path.join(process.env.CHECKCC_DESKTOP_USER_DATA, 'state');
process.env.CHECKCC_NODE_EXECUTABLE = process.execPath;
let helper, gateway, site, settings, powerTimer, stopping, kernel, resetPending = false;
let queue = Promise.resolve(), shutdownRequested = false;
let finishStartup;
const startupFinished = new Promise(resolve => { finishStartup = resolve; });
let login = { openAtLogin: false, status: null };
const protocol = createProtocol({ input: process.stdin, output: process.stdout,
  dispatch: (method, params) => {
    const next = queue.then(() => startupFinished).then(() => dispatch(method, params));
    queue = next.catch(() => {});
    return next;
  }, onDisconnect: () => orphaned(),
});
const native = (method, params) => protocol.request(method, params);
const store = createDesktopSettings({ userData: process.env.CHECKCC_DESKTOP_USER_DATA, app: {
  isPackaged: !devURL,
  getLoginItemSettings: () => login,
  setLoginItemSettings: async ({ openAtLogin }) => { login = await native('set_login', { enabled: openAtLogin }); },
} });
const reset = createClaudeReset({ trash: target => native('trash', { path: target }) });
const headers = { Origin: origin, 'X-CheckCC-Client': 'repair-ui' };
async function report() {
  const response = await fetch(helper.url + '/protection', { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('无法确认保护状态。');
  return response.json();
}
const closeRuntime = createShutdown({ restore: () => helper?.closeRuntime(), closeServices: async () => {
    clearInterval(powerTimer);
    // 退出时必须把定时器与内核一并关掉：否则进程退了、内核仍在接管流量（实测事故）。
    kernel?.stopAutoRefresh?.();
    kernel?.stopPublicDnsSync?.();
    // 内核未确认退出时保留页面与控制接口，允许用户查看错误并重试退出。
    await kernel?.stop();
    await closeServer(helper?.server);
    await closeServer(gateway);
    await closeServer(site);
} });
async function close() {
  stopping = closeRuntime().catch(error => { stopping = null; throw error; });
  return stopping;
}
async function orphaned() {
  let code = shutdownRequested ? 0 : 1;
  try { await queue.catch(() => {}); await close(); } catch (error) { code = 1; console.error('[desktop] 原始备份已保留：', error.message); }
  finally { process.exit(code); }
}
async function dispatch(method, params) {
  if (method === 'shutdown') { await close(); shutdownRequested = true; return { restored: true }; }
  if (stopping) throw new Error('应用正在退出。');
  if (method === 'getSettings') { if (!devURL) login = await native('get_login'); return store.get(); }
  if (method === 'updateSettings') {
    if (!devURL) login = await native('get_login');
    settings = await store.update(params); return settings;
  }
  if (method !== 'resetClaude') throw new Error('不支持的桌面操作。');
  if (resetPending) return { error: '正在恢复初始化，请稍后重试。' };
  resetPending = true;
  try {
    const protection = await report();
    if (protection.enabled || protection.phase !== 'idle') throw new Error('请先关闭保护并完成配置恢复，再重置 Claude。');
    const plan = await reset.preview();
    if (plan.running) throw new Error('请先退出 Claude 客户端及其后台任务，再重试。');
    if (!plan.paths.length) return { complete: true, cleared: [], message: '未发现支持的 Claude 桌面客户端本地数据目录。' };
    if (!await native('confirm_reset', { paths: plan.paths })) return { cancelled: true };
    const confirmedProtection = await report();
    if (confirmedProtection.enabled || confirmedProtection.phase !== 'idle') throw new Error('保护状态已变化，请先关闭保护并完成恢复，再重试。');
    return { ...await reset.reset(plan.paths), message: '已将 Claude 桌面客户端的本地数据移至废纸篓/回收站，清空前仍可恢复。' };
  } catch (error) { return { error: error.message, cleared: error.cleared ?? [] }; }
  finally { resetPending = false; }
}
try {
  if (!devURL) login = await native('get_login');
  settings = await store.load();
  const { createGateway } = await import('../scripts/claude-gateway.mjs');
  const { createKernelRuntime } = await import('../scripts/net-core/runtime.mjs');
  // 内核先于网关：页面通过网关诊断接口读取内核状态。未配置节点时保持“未启用”。
  kernel = await createKernelRuntime({
    stateDir: process.env.CHECKCC_STATE_DIR,
    root,
    logger: (line) => console.error('[net-core]', line),
  });
  if (kernel.enabled) {
    if (!await kernel.start()) console.error('[net-core] 内核未能启动，页面会显示未启用原因。');
    kernel.startAutoRefresh?.();
    kernel.startPublicDnsSync?.();
  } else {
    console.error('[net-core] 未启用：', kernel.reason);
  }
  gateway = createGateway({ netCore: kernel });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(devURL ? 3010 : 0, '127.0.0.1', resolve); });
  process.env.CHECKCC_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  const { startRepairHelper } = await import('../scripts/local-repair.mjs');
  helper = await startRepairHelper(devURL ? 3001 : 0, { netCore: kernel });
  if (!helper.server) { helper = null; throw new Error('本机助手端口已被占用，请先退出旧服务。'); }
  const ports = { helper: helper.server.address().port, gateway: gateway.address().port };
  if (!devURL) {
    site = await startSite(path.join(root, 'out'), ports, Number(process.env.CHECKCC_DESKTOP_SITE_PORT ?? 3030));
    origin = `http://127.0.0.1:${site.address().port}`;
    headers.Origin = origin;
  }
  const protection = await report();
  if (protection.phase === 'idle') {
    const response = await fetch(helper.url + '/session?tokenOnly=1', { headers });
    const session = await response.json();
    const configured = await fetch(helper.url + '/protection', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token }, body: JSON.stringify({ action: 'startup', enabled: settings.autoStartProtection }), signal: AbortSignal.timeout(120000) });
    if (!configured.ok) throw new Error('无法应用启动保护设置：' + (await configured.json()).error);
  }
  powerTimer = setInterval(() => { void report().then(value => protocol.send({ type: 'power', enabled: Boolean(value.enabled || value.desiredEnabled) })).catch(() => {}); }, 2500);
  powerTimer.unref();
  protocol.send({ type: 'ready', url: origin, ports });
} catch (error) {
  console.error('[desktop] 启动失败：', error.message);
  try { await close(); } catch (cleanup) { console.error('[desktop] 配置恢复未完成，备份已保留：', cleanup.message); }
  protocol.send({ type: 'failed', error: error.message });
  process.exitCode = 1;
  protocol.close();
} finally { finishStartup(); }
process.once('SIGTERM', () => { void orphaned(); });
process.once('SIGINT', () => { void orphaned(); });
