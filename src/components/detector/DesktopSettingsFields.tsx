"use client";
import { useEffect, useState } from 'react';
import type { LocaleCode } from '@/i18n/messages';

type Settings = { openAtLogin: boolean; autoStartProtection: boolean; canOpenAtLogin: boolean; loginStatus: string | null };
type ResetResult = { cancelled?: boolean; complete?: boolean; cleared?: string[]; message?: string; error?: string };
type Bridge = { getSettings: () => Promise<Settings>; updateSettings: (patch: Partial<Pick<Settings, 'openAtLogin' | 'autoStartProtection'>>) => Promise<Settings>; resetClaude: () => Promise<ResetResult> };
declare global { interface Window { envGuardDesktop?: Bridge } }

export function DesktopSettingsFields({ locale, protectionEnabled = false }: { locale: LocaleCode; protectionEnabled?: boolean }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const resetClaude = async () => {
    if (resetting || !window.envGuardDesktop?.resetClaude) return;
    setResetting(true); setError(''); setResetMessage('');
    try {
      const result = await window.envGuardDesktop.resetClaude();
      if (result.error) setError(result.error + (result.cleared?.length ? text(`（已清理 ${result.cleared.length} 个位置，其余未完成）`, ` (${result.cleared.length} locations cleared; remaining locations were not reset)`) : ''));
      else if (!result.cancelled) setResetMessage(result.message || text('本地数据重置完成。', 'Local data reset completed.'));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setResetting(false); }
  };
  useEffect(() => {
    let alive = true;
    window.envGuardDesktop?.getSettings().then(value => { if (alive) setSettings(value); }).catch(failure => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, []);
  const update = async (key: 'openAtLogin' | 'autoStartProtection', value: boolean) => {
    if (saving || !window.envGuardDesktop) return;
    setSaving(true); setError('');
    try { setSettings(await window.envGuardDesktop.updateSettings({ [key]: value })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  const rows = [
    ['openAtLogin', text('开机自启动', 'Launch at login'), text('登录系统后在后台启动，需使用已安装的桌面版。', 'Start in the background after login; requires an installed desktop app.')],
    ['autoStartProtection', text('启动后自动开启保护', 'Enable protection on startup'), text('下次启动应用时生效。', 'Applies on the next app launch.')],
  ] as const;
  return <>{rows.map(([key, label, hint]) => <div key={key}>
    <dt title={hint}>{label}</dt>
    <dd><label className="workspace-monitor" title={!settings ? text('仅桌面应用可设置', 'Available in the desktop app') : hint}>
      <input type="checkbox" role="switch" aria-label={label} checked={Boolean(settings?.[key])}
        disabled={!settings || saving || resetting || key === 'openAtLogin' && !settings.canOpenAtLogin}
        onChange={event => void update(key, event.target.checked)} />
      <span className="sr-only">{label}</span>
    </label></dd>
  </div>)}
    <div><dt>{text('Claude 恢复初始化', 'Reset Claude Desktop')}</dt><dd><button className="repair-button" type="button" disabled={!settings || saving || resetting || protectionEnabled} aria-busy={resetting} onClick={() => void resetClaude()} title={text('先关闭保护并退出 Claude。清理范围会在确认窗口中列出。', 'Stop protection and quit Claude first. Review affected data before confirming.')}>
      {resetting ? text('正在处理…', 'Processing…') : text('恢复初始化', 'Reset local data')}
    </button></dd></div>
    {resetMessage && <div><dt>{text('初始化结果', 'Reset result')}</dt><dd role="status">{resetMessage}</dd></div>}
    {settings?.loginStatus === 'requires-approval' && <div><dt>{text('自启动状态', 'Login status')}</dt><dd>{text('请在系统登录项中允许应用启动', 'Allow the app in system login items')}</dd></div>}
    {error && <div><dt>{text('设置状态', 'Settings status')}</dt><dd role="alert">{error}</dd></div>}
  </>;
}
