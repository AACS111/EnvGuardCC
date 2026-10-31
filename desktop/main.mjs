import { app, BrowserWindow, Menu, dialog, shell, powerMonitor, powerSaveBlocker } from 'electron';
import http from 'node:http';
import { constants, mkdirSync } from 'node:fs';
import { access, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdownHelper } from '../scripts/helper-connection.mjs';
import { watchDesktopPower } from '../scripts/desktop-power.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devURL = process.env.CHECKCC_DESKTOP_DEV_URL;
let window, helper, gateway, site, quitting = false, stopping = false;
let stopPower, startup, failureExitCode = 0;

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
    if (stopping || quitting || !window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
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
        if (window && !window.isDestroyed()) { window.setEnabled(true); window.setTitle('EnvGuardCC · 配置恢复未完成'); }
        await dialog.showMessageBox({ type: 'error', title: '自动恢复未完成', message: '原始备份已保留。请检查权限或连接，随后再次关闭模拟保护或退出应用。', detail: error.message, buttons: ['返回应用'] });
      }
    })();
  });
  startup = app.whenReady().then(async () => {
    if (stopping) return;
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
    window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 420, minHeight: 640, title: 'EnvGuardCC', icon: process.platform === 'darwin' ? path.join(root, 'public', 'envguardcc-icon.png') : path.join(root, 'desktop', 'envguardcc.ico'), show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    if (process.platform !== 'darwin') window.removeMenu();
    const external = (url) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); };
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== siteOrigin) { event.preventDefault(); external(url); } });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); app.quit(); } });
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
    } else window.show();
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
