import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { findDesktop } from './environment-runtime.mjs';
import { selectedProxy } from './gateway-proxy.mjs';
import { createDesktopGateway } from './desktop-gateway.mjs';
import { stopManagedProcess } from './managed-process.mjs';
import { DesktopLocale, desktopLocale } from './desktop-locale.mjs';

export class DesktopLauncher {
  constructor({ stateDir, findExecutable = findDesktop, startProcess = spawn, resolveProxy = selectedProxy } = {}) {
    this.stateDir = stateDir;
    this.findExecutable = findExecutable;
    this.startProcess = startProcess;
    this.resolveProxy = resolveProxy;
    this.state = 'idle';
    this.error = null;
    this.localeProfile = new DesktopLocale(stateDir);
  }
  snapshot() {
    return { version: 1, state: this.state, pid: this.child?.pid ?? null, startedAt: this.startedAt ?? null, error: this.error, locale: this.localeProfile.locale ?? null, gateway: this.relay ? { url: this.gatewayUrl, ...this.relay.snapshot() } : null };
  }
  launch(target = {}) {
    if (this.closed) return Promise.reject(new Error('应用正在退出，请重新打开 EnvGuardCC。'));
    if (this.pending) return this.pending;
    if (this.state === 'running') return Promise.resolve(this.snapshot());
    this.pending = this.start(target).finally(() => { this.pending = null; });
    return this.pending;
  }
  async start(target) {
    this.state = 'starting'; this.error = null;
    let relay;
    try {
      const executable = await this.findExecutable();
      const profile = path.join(this.stateDir, 'managed-claude-desktop');
      await mkdir(profile, { recursive: true });
      if (target.locale || target.language) {
        const locale = desktopLocale(target.locale || target.language);
        try { await access(path.join(path.dirname(executable), 'resources', `${locale}.json`)); }
        catch { throw new Error(`当前 Claude 版本未提供 ${locale} 界面语言。`); }
        await this.localeProfile.apply(locale);
      }
      relay = createDesktopGateway({ proxy: this.resolveProxy() });
      await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve); });
      this.relay = relay;
      this.gatewayUrl = `http://127.0.0.1:${relay.server.address().port}`;
      const env = { ...process.env, HTTP_PROXY: this.gatewayUrl, HTTPS_PROXY: this.gatewayUrl, ALL_PROXY: this.gatewayUrl, http_proxy: this.gatewayUrl, https_proxy: this.gatewayUrl, all_proxy: this.gatewayUrl, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      // Claude rejects Chromium network/debug switches. Its renderer uses the system proxy;
      // proxy environment variables remain available to compatible Node subprocesses.
      const args = [`--user-data-dir=${profile}`, ...(this.localeProfile.locale ? [`--lang=${this.localeProfile.locale}`] : [])];
      const child = this.startProcess(executable, args, { env, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let startupError = '';
      child.stderr?.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-4096); });
      this.child = child;
      child.on('error', () => {});
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        this.state = 'exited';
        void relay.close();
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      // A singleton handoff or rejected startup often exits immediately. Never report it as a managed session.
      await new Promise(resolve => setTimeout(resolve, 900));
      if (child.exitCode !== null || child.signalCode !== null || this.child !== child) {
        const reason = /refusing to start.*(?:debugging|network-override)/i.test(startupError)
          ? '客户端拒绝调试或网络覆盖启动参数。'
          : child.exitCode === 0 ? '客户端可能已将启动请求转交给已有实例。' : '请检查 Claude 客户端日志。';
        throw new Error(`Claude 启动进程已退出（${child.signalCode ?? child.exitCode ?? '未知退出状态'}）。${reason}`);
      }
      this.state = 'running'; this.startedAt = new Date().toISOString();
      child.unref();
      return this.snapshot();
    } catch (error) {
      this.state = 'failed'; this.error = error.message;
      if (this.child?.exitCode !== null || !this.child?.pid) this.child = null;
      await relay?.close();
      await this.localeProfile.restore();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
    await stopManagedProcess(this.child);
    await this.localeProfile.restore();
    await this.relay?.close();
  }
}
