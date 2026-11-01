import { app, BrowserWindow, Menu, dialog, shell, powerMonitor, powerSaveBlocker, Tray, nativeImage, ipcMain } from 'electron';
import http from 'node:http';
import { constants, mkdirSync } from 'node:fs';
import { access, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdownHelper } from '../scripts/helper-connection.mjs';
import { watchDesktopPower } from '../scripts/desktop-power.mjs';
import { createDesktopSettings, shouldHideOnClose } from '../scripts/desktop-settings.mjs';
import { createClaudeReset } from '../scripts/claude-reset.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devURL = process.env.CHECKCC_DESKTOP_DEV_URL;
let window, helper, gateway, site, quitting = false, stopping = false;
let stopPower, startup, failureExitCode = 0;
let tray, desktopSettings;
let resettingClaude = false;
const claudeReset = createClaudeReset({ trash: target => shell.trashItem(target) });
const settingsController = createDesktopSettings({ app, userData: process.env.CHECKCC_DESKTOP_USER_DATA || path.join(app.getPath('appData'), app.isPackaged ? 'CheckCC' : 'check-cc') });
function showWindow() {
  if (stopping || quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function hideWindow() {
  if (!tray) { window.minimize(); return; }
  if (window.isFullScreen()) {
    window.once('leave-full-screen', () => { if (!quitting && !stopping) window.hide(); });
    window.setFullScreen(false);
  } else window.hide();
}
async function configureProtectionStartup(helperUrl, origin) {
  const headers = { Origin: origin, 'X-CheckCC-Client': 'repair-ui' };
  const current = await (await fetch(helperUrl + '/protection', { headers })).json();
  if (current.phase !== 'idle') return; // Never take over another running protection session.
  const session = await (await fetch(helperUrl + '/session?tokenOnly=1', { headers })).json();
  const result = await fetch(helperUrl + '/protection', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token },
    body: JSON.stringify({ action: 'startup', enabled: desktopSettings.autoStartProtection }), signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) throw new Error('无法应用启动保护设置：' + (await result.json()).error);
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
// Keep existing profiles and recovery backups when changing the display name.
const userData = process.env.CHECKCC_DESKTOP_USER_DATA || path.join(app.getPath('appData'), app.isPackaged ? 'CheckCC' : 'check-cc');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setName('EnvGuardCC');
if (!app.requestSingleInstanceLock()) {
  // A secondary process owns no services or state. Never register restore handlers here.
  app.quit();
} else {
  if (devURL) process.stdin.on('data', data => { if (data.toString().trim() === 'quit') app.quit(); });
  app.on('second-instance', () => {
    showWindow();
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!quitting && !stopping) app.quit(); });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (resettingClaude) { showWindow(); return; }
    if (stopping) return;
    stopping = true;
    if (window && !window.isDestroyed()) { window.setEnabled(false); window.setTitle('EnvGuardCC · 正在自动恢复配置…'); }
    void (async () => {
      try {
        // A quit during startup must not leave a later-created service behind.
        await startup?.catch(() => {});
        if (devURL) {
          // The development helper lives in the launcher process. Restore before closing this window.
          await shutdownHelper('http://127.0.0.1:3001', new URL(devURL).origin);
        }
        await helper?.closeRuntime();
        await closeServer(helper?.server);
        await closeServer(gateway);
        await closeServer(site);
        stopPower?.();
        quitting = true;
        if (failureExitCode) app.exit(failureExitCode);
        else app.quit();
      } catch (error) {
        stopping = false;
        if (process.env.CHECKCC_DESKTOP_SMOKE === '1') {
          // A smoke run has no user to retry cleanup, so do not hang on a dialog.
          console.error(error);
          app.exit(failureExitCode || 1);
          return;
        }
        if (window && !window.isDestroyed()) { window.setEnabled(true); window.setTitle('EnvGuardCC · 配置恢复未完成'); window.show(); }
        await dialog.showMessageBox({ type: 'error', title: '自动恢复未完成', message: '原始备份已保留。请检查权限或连接，随后再次关闭模拟保护或退出应用。', detail: error.message, buttons: ['返回应用'] });
      }
    })();
  });
  startup = app.whenReady().then(async () => {
    if (stopping) return;
    desktopSettings = await settingsController.load();
    app.once('will-quit', () => { tray?.destroy(); tray = null; });
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
    }
    if (!devURL) {
    const runtimeNode = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    try { await access(runtimeNode, process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
    catch (error) { throw new Error(`内置 Node 运行文件不可用：${runtimeNode}`, { cause: error }); }
    process.env.CHECKCC_NODE_EXECUTABLE = runtimeNode;
    process.env.CHECKCC_STATE_DIR ||= path.join(app.getPath('userData'), 'state');
    const { createGateway } = await import('../scripts/claude-gateway.mjs');
    gateway = createGateway();
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    if (stopping) return;
    process.env.CHECKCC_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    const { startRepairHelper } = await import('../scripts/local-repair.mjs');
    helper = await startRepairHelper(0);
    if (!helper.server) throw new Error('本机助手端口已被其他 EnvGuardCC 实例占用，请先退出原来的开发服务。');
    if (stopping) return;
    const publicRoot = path.resolve(root, 'out');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
    site = http.createServer(async (req, res) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
        let requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        let file = path.resolve(publicRoot, '.' + requested);
        if (!file.startsWith(publicRoot + path.sep) && file !== publicRoot) { res.writeHead(403); return res.end(); }
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        let data = await readFile(file);
        if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('<head>', `<head><script>globalThis.__CHECKCC_PORTS__=${JSON.stringify({ helper: helper.server.address().port, gateway: gateway.address().port })}</script>`));
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch { res.writeHead(404); res.end('Not found'); }
    });
    await new Promise((resolve, reject) => { site.once('error', reject); site.listen(process.env.CHECKCC_DESKTOP_SMOKE === '1' ? 0 : 3030, '127.0.0.1', resolve); });
    }
    const siteOrigin = devURL || `http://127.0.0.1:${site.address().port}`;
    if (stopping) return;
    await configureProtectionStartup(helper?.url || 'http://127.0.0.1:3001', new URL(siteOrigin).origin);
    const checkSender = event => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(siteOrigin).origin) throw new Error('拒绝非主窗口的设置请求。');
    };
    ipcMain.handle('envguardcc:desktop-settings:get', event => { checkSender(event); return settingsController.get(); });
    ipcMain.handle('envguardcc:desktop-settings:update', async (event, patch) => {
      checkSender(event);
      const value = await settingsController.update(patch);
      desktopSettings = value;
      return value;
    });
    ipcMain.handle('envguardcc:claude-reset', async event => {
      checkSender(event);
      if (resettingClaude || stopping || quitting) return { error: '应用正在处理操作，请稍后重试。' };
      resettingClaude = true;
      try {
        const response = await fetch((helper?.url || 'http://127.0.0.1:3001') + '/protection', {
          headers: { Origin: new URL(siteOrigin).origin, 'X-CheckCC-Client': 'repair-ui' }, signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('无法确认保护状态，未清理任何数据。');
        const protection = await response.json();
        if (protection.enabled || protection.phase !== 'idle') throw new Error('请先关闭保护并完成配置恢复，再重置 Claude。');
        const plan = await claudeReset.preview();
        if (plan.running) throw new Error('请先从 Claude 菜单退出客户端，并结束其后台任务，再重试。');
        if (!plan.paths.length) return { complete: true, cleared: [], message: '未发现支持的 Claude 桌面客户端本地数据目录。若客户端仍保留数据，请使用 Claude 自带的“重置应用数据”。' };
        const confirmation = await dialog.showMessageBox(window, {
          type: 'warning', title: 'Claude 恢复初始化',
          message: '重置 Claude 桌面客户端的本地数据？',
          detail: '将清除下列位置的登录状态、缓存、设置、MCP 配置及本地 Cowork/桌面会话数据。云端聊天和账号记录、浏览器及 Claude Code 数据不受影响。\n\n数据将移至系统废纸篓/回收站，未清空前仍可恢复。不会修改设备标识或保证解除账号关联。\n\n' + plan.paths.join('\n'),
          buttons: ['取消', '恢复初始化'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (confirmation.response !== 1) return { cancelled: true };
        const result = await claudeReset.reset(plan.paths);
        return { ...result, message: '已将支持位置的 Claude 桌面客户端本地数据移至废纸篓/回收站。重新打开 Claude 检查初始设置和登录状态。废纸篓清空前数据仍可恢复。' };
      } catch (error) { return { error: error.message, cleared: error.cleared ?? [] }; }
      finally { resettingClaude = false; }
    });
    window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 420, minHeight: 640, title: 'EnvGuardCC', icon: process.platform === 'darwin' ? path.join(root, 'public', 'envguardcc-icon.png') : path.join(root, 'desktop', 'envguardcc.ico'), show: false, webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    if (process.platform !== 'darwin') window.removeMenu();
    const external = (url) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); };
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== siteOrigin) { event.preventDefault(); external(url); } });
    try {
      const image = nativeImage.createFromPath(path.join(root, 'public', 'envguardcc-icon.png')).resize({ width: 18, height: 18 });
      tray = new Tray(image);
      tray.setToolTip('EnvGuardCC');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示主窗口 / Show window', click: showWindow },
        { type: 'separator' },
        { label: '退出并恢复配置 / Quit and restore', click: () => app.quit() },
      ]));
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
    } catch (error) { console.warn('[desktop] 无法创建托盘，将使用任务栏最小化：' + error.message); }
    window.on('close', event => {
      if (quitting) return;
      event.preventDefault();
      if (stopping) return;
      if (shouldHideOnClose({ quitting, stopping })) hideWindow();
      else app.quit();
    });
    await window.loadURL(siteOrigin + "/");
    if (stopping) return;
    stopPower = watchDesktopPower({
      powerMonitor, powerSaveBlocker,
      readReport: async () => {
        const helperUrl = helper?.url || 'http://127.0.0.1:3001';
        const response = await fetch(helperUrl + '/protection', { headers: { Origin: new URL(siteOrigin).origin, 'X-CheckCC-Client': 'repair-ui' }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
      notify: () => {
        if (!stopping && window && !window.isDestroyed()) void window.webContents.executeJavaScript("window.dispatchEvent(new Event('checkcc:resume'))").catch(() => {});
      },
    });
    if (devURL && process.env.CHECKCC_DESKTOP_SMOKE === '1') {
      window.show();
      if (!window.isVisible()) throw new Error('Desktop development window is hidden');
      const result = await window.webContents.executeJavaScript(`(async () => {
        const helper = await (await fetch('http://127.0.0.1:3001/session', { headers: { 'X-CheckCC-Client': 'repair-ui' } })).json();
        const gateway = await (await fetch('http://127.0.0.1:3010/__checkcc/status', { headers: { 'X-CheckCC-Client': 'gateway-ui' } })).json();
        return { title: document.title, helperConnected: typeof helper.token === 'string', gatewayConnected: gateway.version === 1, nodeIntegration: typeof require !== 'undefined' };
      })()`);
      if (stopping) return;
      if (!result.title || !result.helperConnected || !result.gatewayConnected || result.nodeIntegration) throw new Error('Desktop development smoke check failed: ' + JSON.stringify(result));
      console.log('[dev:electron] smoke ' + JSON.stringify({ ...result, windowVisible: window.isVisible() }));
      app.quit();
      return;
    }
    if (process.env.CHECKCC_DESKTOP_SMOKE === '1') {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const waitFor = async (read, label, attempts = 100) => {
          for (let i = 0; i < attempts; i++) {
            const value = read();
            if (value) return value;
            await wait(100);
          }
          throw new Error('Timed out waiting for ' + label);
        };
        const workspace = await waitFor(() => document.querySelector('.check-workspace') || document.querySelector('.protection-workspace'), 'workspace');
        const area = workspace.getBoundingClientRect();
        if (area.width <= 0 || area.height <= 0) throw new Error('Workspace is not visible');
        if (!document.title.trim()) throw new Error('Page title is missing');
        if (!document.body.innerText.trim()) throw new Error('Page content is missing');
        const stylesLoaded = await waitFor(() => [...document.styleSheets].some(sheet => {
          try { return sheet.cssRules.length > 0; } catch { return false; }
        }), 'page styles');
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        if (!tabs.length) throw new Error('Navigation tabs are missing');
        const panels = [];
        for (const tab of tabs) {
          const panelId = tab.getAttribute('aria-controls');
          const panel = panelId && document.getElementById(panelId);
          if (!panel) throw new Error('A tab is missing its panel');
          tab.click();
          await waitFor(() => !panel.hidden && tab.getAttribute('aria-selected') === 'true', 'tab panel');
          panels.push(panelId);
        }
        const cards = [...document.querySelectorAll('[data-signal-card]')];
        if (!cards.length) throw new Error('Signal cards are missing');
        const action = await waitFor(() => cards.map(card => card.querySelector('button')).find(button => button && !button.disabled), 'card action', 300);
        const cardTab = tabs.find(tab => {
          const panel = document.getElementById(tab.getAttribute('aria-controls'));
          return panel && panel.contains(action);
        });
        if (cardTab) {
          cardTab.click();
          await waitFor(() => cardTab.getAttribute('aria-selected') === 'true', 'card tab');
        }
        action.click();
        const dialog = await waitFor(() => document.querySelector('dialog[open]'), 'details dialog');
        const close = await waitFor(() => {
          const button = dialog.querySelector('header button');
          return button && !button.disabled ? button : null;
        }, 'dialog close', 350);
        close.click();
        await waitFor(() => !document.querySelector('dialog[open]'), 'dialog close');
        const ports = globalThis.__CHECKCC_PORTS__;
        if (!ports || !Number.isInteger(ports.helper) || !Number.isInteger(ports.gateway)) throw new Error('Desktop service ports are missing');
        const fetchJson = async (url, headers) => {
          const response = await fetch(url, { headers, cache: 'no-store' });
          if (!response.ok) throw new Error('Desktop service returned HTTP ' + response.status);
          return response.json();
        };
        const helper = await fetchJson('http://127.0.0.1:' + ports.helper + '/protection', { 'X-CheckCC-Client': 'repair-ui' });
        const gateway = await fetchJson('http://127.0.0.1:' + ports.gateway + '/__checkcc/status', { 'X-CheckCC-Client': 'gateway-ui' });
        if (typeof helper.enabled !== 'boolean') throw new Error('Helper protection state is unavailable');
        if (gateway.version !== 1) throw new Error('Gateway status is unavailable');
        const nodeIntegration = typeof require !== 'undefined' || typeof module !== 'undefined' || Boolean(globalThis.process?.versions?.electron);
        if (nodeIntegration) throw new Error('Renderer has Node integration');
        return {
          title: document.title,
          content: { textLength: document.body.innerText.trim().length, workspaceVisible: area.width > 0 && area.height > 0 },
          styles: { loaded: stylesLoaded, stylesheets: document.styleSheets.length },
          navigation: { tabs: tabs.length, panels },
          cards: { count: cards.length, dialogOpened: Boolean(dialog) },
          services: { helper: true, gateway: true },
          isolation: { nodeIntegration },
        };
      })()`);
      if (stopping) return;
      if (!result.content.workspaceVisible || !result.styles.loaded || !result.cards.dialogOpened || !result.services.helper || !result.services.gateway || result.isolation.nodeIntegration) throw new Error('Desktop smoke check failed: ' + JSON.stringify(result));
      const output = process.env.CHECKCC_SMOKE_REPORT || path.join(process.env.CHECKCC_STATE_DIR, 'smoke.json');
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2));
      app.quit();
    } else {
      const loginLaunch = process.argv.includes('--envguardcc-login') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
      if (!loginLaunch || !tray) window.show();
    }
  }).catch(async (error) => {
    if (process.env.CHECKCC_DESKTOP_SMOKE === '1') {
      console.error(error);
      failureExitCode = 1;
      if (!stopping) app.quit();
      return;
    }
    if (stopping) { console.error(error); return; }
    await dialog.showMessageBox({ type: 'error', title: 'EnvGuardCC 启动失败', message: error.message, detail: '请确认应用端口 3030 未被占用。' });
    app.quit();
  });
}
