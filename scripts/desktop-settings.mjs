import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const defaultDesktopSettings = Object.freeze({ openAtLogin: false, autoStartProtection: false });
export function desktopSettingsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的桌面设置。');
  for (const [key, setting] of Object.entries(value)) {
    if (!Object.hasOwn(defaultDesktopSettings, key) || typeof setting !== 'boolean') throw new Error('无效的桌面设置。');
  }
  return value;
}
export function loginItemOptions(platform, executable) {
  return platform === 'win32' ? { path: executable, args: ['--envguardcc-login'] } : {};
}
export function shouldHideOnClose({ quitting, stopping }) {
  return !quitting && !stopping;
}
export function createDesktopSettings({ app, userData, platform = process.platform, executable = process.execPath }) {
  const file = path.join(userData, 'desktop-settings.json');
  const canOpenAtLogin = app.isPackaged && ['darwin', 'win32'].includes(platform);
  let settings = { ...defaultDesktopSettings };
  let queue = Promise.resolve();
  const options = loginItemOptions(platform, executable);
  const report = () => {
    const login = canOpenAtLogin ? app.getLoginItemSettings(options) : {};
    return { ...settings, openAtLogin: canOpenAtLogin ? Boolean(login.openAtLogin) : false,
      canOpenAtLogin, loginStatus: login.status || null, platform };
  };
  return {
    async load() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        // Ignore the retired close-window option from development previews.
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) delete saved.minimizeToTray;
        settings = { ...defaultDesktopSettings, ...desktopSettingsPatch(saved) };
      }
      catch (error) { if (error.code !== 'ENOENT') console.warn('[desktop-settings] 使用默认设置：' + error.message); }
      return report();
    },
    get: report,
    update(patch) {
      const next = queue.then(async () => {
        desktopSettingsPatch(patch);
        if (Object.hasOwn(patch, 'openAtLogin') && !canOpenAtLogin) throw new Error('开机自启动需使用已安装的 Windows 或 macOS 桌面版。');
        const previous = report();
        const updated = { ...settings, ...patch };
        try {
          if (Object.hasOwn(patch, 'openAtLogin')) app.setLoginItemSettings({ ...options, openAtLogin: patch.openAtLogin });
          await mkdir(userData, { recursive: true });
          await writeFile(file + '.tmp', JSON.stringify(updated), { mode: 0o600 });
          await rename(file + '.tmp', file);
          settings = updated;
        } catch (error) {
          if (Object.hasOwn(patch, 'openAtLogin')) {
            try { app.setLoginItemSettings({ ...options, openAtLogin: previous.openAtLogin }); } catch { /* Report the original failure. */ }
          }
          throw error;
        }
        return report();
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
