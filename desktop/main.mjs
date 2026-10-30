import { app, BrowserWindow, dialog, shell, powerMonitor, powerSaveBlocker } from 'electron';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdownHelper } from '../scripts/helper-connection.mjs';
import { watchDesktopPower } from '../scripts/desktop-power.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devURL = process.env.CHECKCC_DESKTOP_DEV_URL;
let window, helper, gateway, site, quitting = false, stopping = false;
let stopPower;
// Keep existing profiles and recovery backups when changing the display name.
const userData = process.env.CHECKCC_DESKTOP_USER_DATA || path.join(app.getPath('appData'), app.isPackaged ? 'CheckCC' : 'check-cc');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setName('EnvGuardCC');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (devURL) process.stdin.on('data', data => { if (data.toString().trim() === 'quit') app.quit(); });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    if (window && !window.isDestroyed()) { window.setEnabled(false); window.setTitle('EnvGuardCC · 正在自动恢复配置…'); }
    void (async () => {
      try {
        if (devURL) {
          // The development helper lives in the launcher process. Restore before closing this window.
          await shutdownHelper('http://127.0.0.1:3001', new URL(devURL).origin);
        }
        await helper?.closeRuntime();
        if (helper?.server) { helper.server.closeAllConnections(); await new Promise(resolve => helper.server.close(resolve)); }
        if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
        if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
        stopPower?.();
        quitting = true; app.quit();
      } catch (error) {
        stopping = false;
        if (window && !window.isDestroyed()) { window.setEnabled(true); window.setTitle('EnvGuardCC · 配置恢复未完成'); }
        await dialog.showMessageBox({ type: 'error', title: '自动恢复未完成', message: '原始备份已保留。请检查权限或连接，随后再次关闭模拟保护或退出应用。', detail: error.message, buttons: ['返回应用'] });
      }
    })();
  });
  app.whenReady().then(async () => {
    if (!devURL) {
    process.env.CHECKCC_NODE_EXECUTABLE = path.join(root, 'runtime', 'node.exe');
    process.env.CHECKCC_STATE_DIR ||= path.join(app.getPath('userData'), 'state');
    const { createGateway } = await import('../scripts/claude-gateway.mjs');
    gateway = createGateway();
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    process.env.CHECKCC_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    const { startRepairHelper } = await import('../scripts/local-repair.mjs');
    helper = await startRepairHelper(0);
    if (!helper.server) throw new Error('本机助手端口已被其他 EnvGuardCC 实例占用，请先退出原来的开发服务。');
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
    window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 420, minHeight: 640, title: 'EnvGuardCC', icon: path.join(root, 'desktop', 'envguardcc.ico'), show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    window.removeMenu();
    const external = (url) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); };
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== siteOrigin) { event.preventDefault(); external(url); } });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); app.quit(); } });
    await window.loadURL(siteOrigin + "/");
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
      if (!result.title || !result.helperConnected || !result.gatewayConnected || result.nodeIntegration) throw new Error('Desktop development smoke check failed: ' + JSON.stringify(result));
      console.log('[dev:electron] smoke ' + JSON.stringify({ ...result, windowVisible: window.isVisible() }));
      app.quit();
      return;
    }
    if (process.env.CHECKCC_DESKTOP_SMOKE === '1') {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 100 && document.querySelectorAll('[role="tab"]').length !== 3; i++) await wait(100);
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        if (tabs.length !== 3) throw new Error('Expected three tabs');
        tabs[1].click(); await wait(100);
        if (document.querySelector('#panel-tests').hidden) throw new Error('Tests tab did not open');
        const cards = document.querySelectorAll('[data-signal-card]');
        if (!cards.length) throw new Error('No test cards');
        const workspaceDisplay = getComputedStyle(document.querySelector('.protection-workspace')).display;
        const cardHeight = cards[0].getBoundingClientRect().height;
        if (workspaceDisplay !== 'grid' || cardHeight !== 224) throw new Error('Workspace CSS missing: ' + JSON.stringify({ workspaceDisplay, cardHeight }));
        cards[0].querySelector('button').click(); await wait(100);
        const modal = document.querySelector('dialog[open]');
        if (!modal || modal.querySelectorAll('footer button').length !== 1) throw new Error('Expected one confirm action');
        for (let i = 0; i < 350 && modal.querySelector('footer button').disabled; i++) await wait(100);
        if (!modal.querySelector('footer button').textContent.includes('确认并重测')) throw new Error('Confirm action remained busy');
        const ports = globalThis.__CHECKCC_PORTS__;
        const helperStatus = await (await fetch('http://127.0.0.1:' + ports.helper + '/protection', { headers: { 'X-CheckCC-Client': 'repair-ui' } })).json();
        const gatewayStatus = await (await fetch('http://127.0.0.1:' + ports.gateway + '/__checkcc/status', { headers: { 'X-CheckCC-Client': 'gateway-ui' } })).json();
        if (typeof helperStatus.enabled !== 'boolean' || gatewayStatus.version !== 1) throw new Error('Desktop services are unavailable');
        modal.querySelector('header button').click();
        tabs[2].click(); await wait(100);
        if (document.querySelector('#panel-compare').hidden) throw new Error('Comparison tab did not open');
        tabs[0].click(); await wait(100);
        const overflow = document.documentElement.scrollWidth > innerWidth;
        return { tabs: tabs.map(tab => tab.textContent), cards: cards.length, singleAction: true, servicesConnected: true, workspaceDisplay, cardHeight, overflow, nodeIntegration: typeof require !== 'undefined' };
      })()`);
      if (result.overflow || result.nodeIntegration) throw new Error('Desktop layout or isolation check failed');
      const output = process.env.CHECKCC_SMOKE_REPORT || path.join(process.env.CHECKCC_STATE_DIR, 'smoke.json');
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2));
      app.quit();
    } else window.show();
  }).catch(async (error) => {
    if (process.env.CHECKCC_DESKTOP_SMOKE === '1') { console.error(error); quitting = true; app.exit(1); return; }
    await dialog.showMessageBox({ type: 'error', title: 'EnvGuardCC 启动失败', message: error.message, detail: '请确认应用端口 3030 未被占用。' });
    app.quit();
  });
}
