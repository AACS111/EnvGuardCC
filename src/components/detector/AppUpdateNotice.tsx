'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import appPackage from '../../../package.json';
import { readAppUpdate, type AppUpdate } from '@/detection/app-updates';
import type { LocaleCode } from '@/i18n/messages';
import { isDialogBackdropEvent } from './RepairDialog';
import { WorkspaceIcon } from './WorkspaceIcon';
import { ReleaseNotes } from './ReleaseNotes';

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const version = appPackage.version;

export function AppUpdateNotice({ locale, connected }: { locale: LocaleCode; connected: boolean }) {
  const [report, setReport] = useState<AppUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const lastAttempt = useRef(0);
  const mounted = useRef(false);
  const check = useCallback(async (force = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = Date.now();
    setBusy(true);
    try {
      const value = await readAppUpdate(force);
      if (!mounted.current) return;
      setFailed(value.status === 'error');
      // A failed recheck must not remove a previously discovered update.
      setReport(previous => value.status === 'error' && previous?.status === 'available' ? previous : value);
    } catch { if (mounted.current) setFailed(true); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!connected) return;
    const tick = () => {
      if (!document.hidden && Date.now() - lastAttempt.current >= CHECK_INTERVAL) void check();
    };
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('online', tick);
    return () => {
      clearTimeout(initial); clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('online', tick);
    };
  }, [connected, check]);

  const zh = locale.startsWith('zh');
  const available = report?.status === 'available';
  const newer = available || report?.status === 'pending' || report?.status === 'unsupported';
  const label = available ? (zh ? '可更新' : 'Update available') : newer ? (zh ? '新版本' : 'New release') : busy ? (zh ? '检查中' : 'Checking') : '';
  return <>
    <div className="workspace-update">
      <button type="button" className="workspace-text-link workspace-update__button" aria-haspopup="dialog" onClick={() => { setOpen(true); void check(true); }}>
        <WorkspaceIcon name="refresh" /><span>{zh ? '检查更新' : 'Updates'}</span>
        {label && <span className="workspace-update__badge" data-available={available} role="status">{label}</span>}
      </button>
      <span className="workspace-update__version">v{report?.currentVersion ?? version}</span>
    </div>
    {open && <AppUpdateDialog locale={locale} report={report} busy={busy} failed={failed} onCheck={() => void check(true)} onClose={() => setOpen(false)} />}
  </>;
}

export function AppUpdateDialog({ locale, report, busy, failed, onCheck, onClose }: {
  locale: LocaleCode; report: AppUpdate | null; busy: boolean; failed: boolean;
  onCheck: () => void; onClose: () => void;
}) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { element?.close(); previousFocus?.focus({ preventScroll: true }); };
  }, []);

  const available = report?.status === 'available';
  const title = available ? text(`发现新版本 v${report.latestVersion}`, `Version ${report.latestVersion} is available`)
    : busy ? text('正在检查更新…', 'Checking for updates…')
      : failed ? text('暂时无法检查更新', 'Unable to check for updates')
        : report?.status === 'current' ? text('当前无需更新', 'No update is needed')
          : report?.status === 'pending' ? text('新版本安装包尚未就绪', 'Release downloads are not ready')
            : report?.status === 'unsupported' ? text('发现新版本，请查看发布页', 'New release available; see the release page')
              : report?.status === 'no-release' ? text('尚无可用的正式版本', 'No stable release is available')
                : text('检查应用更新', 'Check for app updates');
  const error = report?.error === 'rate-limit' ? text('GitHub 请求受限，请稍后重试。', 'GitHub is limiting requests. Please try again later.')
    : report?.error === 'configuration' ? text('更新来源配置无效，请检查应用配置。', 'The update source is invalid. Check the app configuration.')
      : report?.error === 'invalid-release' ? text('发布信息不完整，暂时无法确认版本。', 'Release information is incomplete; the version could not be verified.')
        : text('请检查网络连接，稍后重试。', 'Check your network connection and try again.');
  return <dialog ref={dialog} className="repair-dialog workspace-updates" aria-labelledby="workspace-updates-title" aria-describedby="workspace-updates-description"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={event => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <div><h2 id="workspace-updates-title"><WorkspaceIcon name="refresh" />{text('应用更新', 'App updates')}</h2><p id="workspace-updates-description">{text('查看正式版本与下载', 'Stable releases and downloads')}</p></div>
      <button type="button" className="repair-button repair-button--quiet" aria-label={text('关闭更新', 'Close updates')} onClick={onClose}>×</button>
    </header>
    <div className="repair-dialog__body workspace-updates__body">
      <h3 role="status">{title}</h3>
      <dl className="workspace-fields">
        <div><dt>{text('当前版本', 'Current version')}</dt><dd>v{report?.currentVersion ?? version}</dd></div>
        {report?.latestVersion && <div><dt>{text('最新正式版本', 'Latest stable version')}</dt><dd>v{report.latestVersion}</dd></div>}
        {report?.checkedAt && <div><dt>{text('上次检查', 'Last checked')}</dt><dd>{new Date(report.checkedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</dd></div>}
      </dl>
      {failed && <p className="workspace-updates__error" role="alert">{error}{available && text(' 仍保留上次发现的新版本信息。', ' The previously discovered update is still shown.')}</p>}
      {report?.status === 'pending' && <p>{text('新版本已发布，当前平台的安装包仍待上传。稍后可再次检查。', 'A new release is published, but downloads for this platform are still pending. Check again later.')}</p>}
      {report?.status === 'unsupported' && <p>{text('当前系统或架构暂无匹配安装包，请到发布页查看。', 'No download matches this system or architecture. See the release page for details.')}</p>}
      {available && <p>{text('下载对应平台的安装包后，从托盘或应用菜单正常退出，等待配置恢复完成，再安装新版本。', 'Download the package for your platform, quit from the tray or app menu, wait for configuration restoration, then install the new version.')}</p>}
      {report?.notes && <section className="workspace-updates__notes"><h4>{text('版本说明', 'Release notes')}</h4><ReleaseNotes baseUrl={report.releaseUrl ?? report.releasesUrl ?? undefined}>{report.notes}</ReleaseNotes></section>}
      <p className="workspace-updates__hint">{text('启动后自动检查，运行期间每 6 小时复查正式版本。', 'Checks stable releases at startup and every 6 hours while running.')}</p>
      <div className="workspace-updates__actions">
        <button type="button" className="repair-button" disabled={busy} aria-busy={busy} onClick={onCheck}>{busy ? text('检查中…', 'Checking…') : text('重新检查', 'Check again')}</button>
        {(report?.releaseUrl || report?.releasesUrl) && <a className="repair-button" href={report.releaseUrl || report.releasesUrl!} target="_blank" rel="noreferrer">{text('查看发布页', 'View release')}</a>}
        {available && report.downloadUrl && <a className="repair-button repair-button--primary" href={report.downloadUrl} target="_blank" rel="noreferrer">{text('下载新版本', 'Download update')}</a>}
      </div>
    </div>
  </dialog>;
}
