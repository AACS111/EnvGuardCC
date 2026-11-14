import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocol } from './protocol.mjs';
import { closeServer, startSite } from './site.mjs';
import { createShutdown } from './lifecycle.mjs';
import { startDesktopServices } from './start-services.mjs';
import { createDesktopSettings } from '../scripts/desktop-settings.mjs';
import { createClaudeReset } from '../scripts/claude-reset.mjs';
import { createClaudeProxySettings } from '../scripts/claude-proxy-settings.mjs';

// Windows GUI launches can inherit a closed stderr pipe. Logging failure must
// leave the control service and its network recovery loop running.
process.stderr.on('error', () => {});
// 打包版没有控制台：宿主把 stderr 落到 <user_data>/logs/backend.log 并传回路径。
// 这里直接追加带时间戳的日志，让“后台已退出”这类事故事后能查到原因。
const logFile = process.env.CHECKCC_BACKEND_LOG;
let logFd = null;
if (logFile) { try { logFd = fs.openSync(logFile, 'a'); } catch { logFd = null; } }
function describe(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
function writeLine(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (logFd !== null) {
    try { fs.writeSync(logFd, text); return; } catch { try { fs.closeSync(logFd); } catch {} logFd = null; }
  }
  // 没有可写的日志目标时必须安静失败，但绝不能打断恢复与网络循环。
  try { process.stderr.write(text); } catch {}
}
for (const level of ['log', 'info', 'debug', 'warn', 'error']) console[level] = (...args) => writeLine(args.map(describe).join(' '));
console.log(`[desktop] 后台启动 pid=${process.pid}${logFile ? `，日志 ${logFile}` : ''}`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devURL = process.env.CHECKCC_DESKTOP_DEV_URL;
let origin = 'http://127.0.0.1:3030';
if (devURL && new URL(devURL).origin !== origin) throw new Error('开发页面必须使用 ' + origin);
if (!process.env.CHECKCC_DESKTOP_USER_DATA) throw new Error('缺少桌面用户数据目录。');
process.env.CHECKCC_STATE_DIR ||= path.join(process.env.CHECKCC_DESKTOP_USER_DATA, 'state');
process.env.CHECKCC_NODE_EXECUTABLE = process.execPath;
let helper, gateway, site, settings, powerTimer, stopping, kernel, servicesReady, resetPending = false;
let queue = Promise.resolve(), shutdownRequested = false, exiting = false;
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
const closeRuntime = createShutdown({ restore: () => helper?.closeRuntime({ kernelWillStop: true }), closeServices: async () => {
    clearInterval(powerTimer);
    // 退出时必须把定时器与内核一并关掉：否则进程退了、内核仍在接管流量（实测事故）。
    kernel?.stopAutoRefresh?.();
    kernel?.stopPublicDnsSync?.();
    // 内核未确认退出时保留页面与控制接口，允许用户查看错误并重试退出。
    await kernel?.stop();
    // kernel.stop() 同时停止采样并保存已结束的本机传输记录。
    await closeServer(helper?.server);
    await closeServer(gateway);
    await closeServer(site);
} });
async function close() {
  kernel?.cancelPending?.();
  // 启动中的后台任务会在下一个检查点看到 stopping 后退出；这里不等待它，
  // 否则退出会被内核/TUN 启动拖住几十秒。
  void servicesReady?.catch(() => {});
  stopping = closeRuntime().catch(error => { stopping = null; throw error; });
  return stopping;
}
function orphaned() { exitAfterRestore(shutdownRequested ? 0 : 1, '宿主连接已断开'); }
// 崩溃与断管同样必须先恢复用户配置：不恢复会把 Claude 代理指向已经死掉的端口。
function exitAfterRestore(code, reason, detail) {
  if (exiting) return;
  exiting = true;
  console.error(`[desktop] ${reason}，开始恢复配置（退出码 ${code}）。`);
  if (detail) console.error(detail);
  // 恢复可能被内核/TUN 拖住；超时也要退出，否则会留下父进程已不在的僵尸后台。
  const watchdog = setTimeout(() => { console.error('[desktop] 恢复超时，强制退出。'); process.exit(code); }, 60000);
  void (async () => {
    try { await queue.catch(() => {}); await close(); }
    catch (error) { code = 1; console.error('[desktop] 恢复未完成，原始备份已保留：', error.message); }
    finally { clearTimeout(watchdog); process.exit(code); }
  })();
}
process.on('uncaughtException', error => exitAfterRestore(1, '未捕获异常', describe(error)));
process.on('unhandledRejection', reason => exitAfterRestore(1, '未处理的 Promise 拒绝', describe(reason)));
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
    // Windows can block Claude independently of TUN. Start protection through
    // its own verified transition, instead of opening and then closing old TUN.
    ...(process.platform === 'win32' ? { initialTunnel: false } : {}),
    claudeProxy: createClaudeProxySettings({ stateDir: process.env.CHECKCC_STATE_DIR }),
    root,
    logger: (line) => console.error('[net-core]', line),
  });
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
  // 页面能访问就先出窗口：内核启动与应用启动保护可能耗时几十秒（等宿主、建 TUN、验证出口），
  // 不能把它们挡在窗口前面，否则用户看到托盘图标却半分钟没有界面。
  protocol.send({ type: 'ready', url: origin, ports });
  finishStartup();
  servicesReady = startServices().catch(error => console.error('[desktop] 后台启动未完成：', error.message));
} catch (error) {
  console.error('[desktop] 启动失败：', error.message);
  try { await close(); } catch (cleanup) { console.error('[desktop] 配置恢复未完成，备份已保留：', cleanup.message); }
  protocol.send({ type: 'failed', error: error.message });
  process.exitCode = 1;
  protocol.close();
} finally { finishStartup(); }

// 内核启动与「应用启动保护」放在窗口之后执行；出错只记录真实原因，页面会按时轮询到。
async function startServices() {
  await startDesktopServices({ kernel, autoStartProtection: settings.autoStartProtection,
    stopping: () => stopping, logger: line => console.error(line), configureProtection: applyStartupProtection });
  if (stopping) return;
  powerTimer = setInterval(() => { void report().then(value => protocol.send({ type: 'power', enabled: Boolean(value.enabled || value.desiredEnabled) })).catch(() => {}); }, 2500);
  powerTimer.unref();
}

async function applyStartupProtection(enabled) {
  // 每次启动都执行启动策略：已有会话要 resume 重新应用（退出时已恢复系统时区），不能只看状态。
  await report();
  if (stopping) return;
  const response = await fetch(helper.url + '/session?tokenOnly=1', { headers });
  const session = await response.json();
  const configured = await fetch(helper.url + '/protection', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token }, body: JSON.stringify({ action: 'startup', enabled }), signal: AbortSignal.timeout(120000) });
  if (!configured.ok) throw new Error('无法应用启动保护设置：' + (await configured.json()).error);
  if (stopping) return;
}
process.once('SIGTERM', () => { void orphaned(); });
process.once('SIGINT', () => { void orphaned(); });
