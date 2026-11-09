"use client";

import { useEffect, useRef, useState } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import type { ProtectionReport } from '@/detection/protection';
import { DesktopSettingsFields } from './DesktopSettingsFields';
import { NetCoreSettings, type NetCoreSettingsProps } from './NetCoreSettings';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';
import { isDialogBackdropEvent } from './RepairDialog';

export type SettingsSection = 'general' | 'network' | 'advanced';
type Props = {
  locale: LocaleCode; initialSection?: SettingsSection; onClose: () => void;
  report: ProtectionReport | null; connected: boolean; busy: boolean;
  onMonitor: (enabled: boolean, intervalMs: number) => void;
  dismissedNoticeCount: number; onRestoreNotices: () => void;
  network: NetCoreSettingsProps;
};

export function WorkspaceSettingsDialog({ locale, initialSection = 'general', onClose, report, connected, busy, onMonitor, dismissedNoticeCount, onRestoreNotices, network }: Props) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const backdropPointerDown = useRef(false);
  const intervalMs = report?.intervalMs ?? 60000;
  const tabs: { id: SettingsSection; label: string; icon: WorkspaceIconName }[] = [
    { id: 'general', label: text('通用', 'General'), icon: 'settings' },
    { id: 'network', label: text('网络', 'Network'), icon: 'network' },
    { id: 'advanced', label: text('高级', 'Advanced'), icon: 'sliders' },
  ];

  const selectSection = (next: SettingsSection) => {
    setSection(next);
    if (body.current) body.current.scrollTop = 0;
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="repair-dialog workspace-settings" aria-labelledby="workspace-settings-title" aria-describedby="workspace-settings-description"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={event => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <div><h2 id="workspace-settings-title"><WorkspaceIcon name="settings" />{text('设置', 'Settings')}</h2><p id="workspace-settings-description">{text('管理检测与网络行为', 'Manage checks and network behavior')}</p></div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} aria-label={text('关闭设置', 'Close settings')}>×</button>
    </header>
    <div className="workspace-settings__tabs" role="tablist" aria-label={text('设置分类', 'Settings categories')}>
      {tabs.map((tab, index) => <button key={tab.id} id={`settings-tab-${tab.id}`} type="button" role="tab" aria-selected={section === tab.id} aria-controls={`settings-panel-${tab.id}`} tabIndex={section === tab.id ? 0 : -1}
        onClick={() => selectSection(tab.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); selectSection(tabs[next].id); document.getElementById(`settings-tab-${tabs[next].id}`)?.focus({ preventScroll: true }); }
        }}><WorkspaceIcon name={tab.icon} />{tab.label}</button>)}
    </div>
    <div ref={body} className="repair-dialog__body workspace-settings__body">
      <div id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" tabIndex={0} hidden={section !== 'general'}>
        <section className="workspace-settings-group"><h3>{text('自动检测', 'Automatic checks')}</h3><p>{text('定期检查当前环境，保留最新检测结果。', 'Check the current environment periodically and keep the latest results.')}</p>
          <dl className="workspace-fields">
            <div><dt>{text('实时检测', 'Monitoring')}</dt><dd><label className="workspace-monitor"><input type="checkbox" role="switch" aria-label={text('实时检测', 'Monitoring')} checked={connected && Boolean(report?.monitoring)} disabled={busy || !connected || !report} onChange={event => onMonitor(event.target.checked, intervalMs)} /><span className="sr-only">{text('实时检测', 'Monitoring')}</span></label></dd></div>
            <div><dt>{text('自动检测间隔', 'Automatic test interval')}</dt><dd><select className="workspace-interval" aria-label={text('自动检测间隔', 'Automatic test interval')} value={intervalMs} disabled={busy || !connected || !report} onChange={event => onMonitor(Boolean(report?.monitoring), Number(event.target.value))}>{[[30000, text('每30秒', 'Every 30 seconds')], [60000, text('每分钟', 'Every minute')], [300000, text('每5分钟', 'Every 5 minutes')], [600000, text('每10分钟', 'Every 10 minutes')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></dd></div>
          </dl>
        </section>
        <section className="workspace-settings-group"><h3>{text('桌面应用', 'Desktop application')}</h3><p>{text('自启动和客户端恢复初始化仅在桌面应用中可用。', 'Startup behavior and client reset are available in the desktop app.')}</p><dl className="workspace-fields"><DesktopSettingsFields locale={locale} protectionEnabled={Boolean(report?.enabled)} /></dl></section>
        <section className="workspace-settings-group"><div className="workspace-settings-group__heading"><div><h3>{text('运行提醒', 'Runtime notices')}</h3><p>{dismissedNoticeCount ? text(`已隐藏 ${dismissedNoticeCount} 项提醒，可恢复显示。`, `${dismissedNoticeCount} notices hidden; restore them here.`) : text('当前没有已隐藏的提醒。', 'No notices are hidden.')}</p></div><button type="button" className="repair-button" disabled={!dismissedNoticeCount} onClick={onRestoreNotices}>{text('恢复提醒', 'Restore notices')}</button></div></section>
      </div>
      <div id="settings-panel-network" role="tabpanel" aria-labelledby="settings-tab-network" tabIndex={0} hidden={section !== 'network'}><NetCoreSettings {...network} /></div>
      <div id="settings-panel-advanced" role="tabpanel" aria-labelledby="settings-tab-advanced" tabIndex={0} hidden={section !== 'advanced'}><NetCoreSettings {...network} advanced /></div>
    </div>
  </dialog>;
}
