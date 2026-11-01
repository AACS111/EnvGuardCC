"use client";

import { useCallback, useEffect, useState } from 'react';
import { helperRequest, helperUrl, type HelperSession } from '@/detection/local-helper';
import type { LocaleCode } from '@/i18n/messages';
import { synchronizeBrowserCloak, type BrowserCloakExecution } from '@/detection/environment-runtime';
import { BrowserCloakStatus } from './BrowserCloakStatus';
import { ClaudeDesktopLaunch } from './ClaudeDesktopLaunch';

type ProxyStatus = { settings: { mode: 'auto' | 'manual' | 'direct'; address?: string }; state: string; source: string; address: string | null; detail: string };
type Recovery = { kind: 'ready' | 'clean' | 'merge' | 'conflict' | 'reload'; reason?: string; fingerprint?: string; originalValid?: boolean; backupDir?: string; changes?: { path: string; change: 'added' | 'removed' | 'modified'; before?: number; after?: number }[] };
type TrafficStatus = { available: boolean; prepared: boolean; controllerReady: boolean; applied: boolean; phase?: string; runtimeVerified?: boolean; groups: string[]; defaultPolicy?: string; detail: string; recovery?: Recovery; stats?: { http: number; tunnels: number; failed: number } };

async function request<T>(path: string, body?: object): Promise<T> {
  const token = body ? (await helperRequest('/session?tokenOnly=1')).token : undefined;
  const response = await fetch(helperUrl + path, {
    method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(120000),
    headers: { 'X-CheckCC-Client': 'repair-ui', ...(body ? { 'Content-Type': 'application/json', 'X-CheckCC-Token': token! } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export function ConnectionSettings({ locale, connected, disabled, protectionEnabled, browserReport, onBrowserReport, onRefresh }: { browserReport: BrowserCloakExecution | null; onBrowserReport?: (report: BrowserCloakExecution) => void; onRefresh: () => void; locale: LocaleCode; connected: boolean; disabled: boolean; protectionEnabled: boolean }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const [session, setSession] = useState<HelperSession | null>(null);
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [traffic, setTraffic] = useState<TrafficStatus | null>(null);
  const [mode, setMode] = useState<ProxyStatus['settings']['mode']>('auto');
  const [address, setAddress] = useState('');
  const [policy, setPolicy] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [next, helper, flow] = await Promise.all([request<ProxyStatus>('/proxy'), helperRequest('/session'), request<TrafficStatus>('/traffic')]);
    setProxy(next); setMode(next.settings.mode); setAddress(next.settings.address || ''); setSession(helper); setTraffic(flow);
    setPolicy(previous => previous || flow.defaultPolicy || flow.groups[0] || '');
  }, []);
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => void load().catch(failure => setError(failure.message)), 0);
    const refreshRecovery = () => void load().catch(failure => setError(failure.message));
    window.addEventListener('checkcc:traffic-recovery', refreshRecovery);
    return () => { clearTimeout(timer); window.removeEventListener('checkcc:traffic-recovery', refreshRecovery); };
  }, [connected, load]);
  const perform = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await action(); await load(); setMessage(result && typeof result === 'object' && 'phase' in result && result.phase === 'restore_pending' ? text('配置已处理。请在 FlClash 重新应用当前配置，再检查恢复状态。', 'Configuration updated. Reapply it in FlClash, then check recovery again.') : success); }
    catch (failure) { await load().catch(() => {}); setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const locked = disabled || busy || !connected;
  return <details className="workspace-panel workspace-details connection-settings">
    <summary>{text('连接设置与 FlClash', 'Connection settings and FlClash')}</summary>
    <form className="connection-settings__form" onSubmit={event => {
      event.preventDefault();
      void perform(() => request('/proxy', { mode, address }), text('代理已保存。请重新接入受控浏览器以使用新路径。', 'Proxy saved. Reconnect the managed browser to use the new route.'));
    }}>
      <label>{text('连接方式', 'Connection mode')}<select value={mode} disabled={locked} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="auto">{text('自动读取系统代理', 'Read system proxy')}</option>
        <option value="manual">{text('指定 HTTP/混合代理', 'Specify HTTP proxy')}</option>
        <option value="direct">{text('使用系统路由（含 TUN）', 'Use system routing (including TUN)')}</option>
      </select></label>
      {mode === 'manual' && <label>{text('代理地址', 'Proxy address')}<input type="url" required value={address} placeholder="http://127.0.0.1:7890" disabled={locked} onChange={event => setAddress(event.target.value)} /></label>}
      <button type="submit" className="repair-button" disabled={locked}>{text('保存连接方式', 'Save connection')}</button>
    </form>
    {proxy && <p className="workspace-meta" role="status">{proxy.address || text('系统路由', 'System routing')} · {({ settings: text('手动配置', 'Manual setting'), environment: text('环境变量', 'Environment'), system: text('系统代理', 'System proxy'), direct: text('系统路由', 'System route') } as Record<string, string>)[proxy.source] || proxy.source}<br />{proxy.detail}</p>}
    <div className="connection-settings__actions">
      <button type="button" className="repair-button" disabled={locked || !protectionEnabled || !session?.capabilities?.browserLaunch} onClick={() => void perform(async () => { const report = await synchronizeBrowserCloak({ launch: true, force: true }); onBrowserReport?.(report); onRefresh(); }, text('接入结果见下方实测报告。', 'See the measured connection results below.'))}>{text('接入并验证浏览器', 'Connect and verify browser')}</button>
      <span>{text('系统时区：', 'System timezone: ')}{session?.timezone || '—'}</span>
      {session?.canRestore && <button type="button" className="repair-button" disabled={locked || !session.capabilities?.timezoneWrite} onClick={() => void perform(async () => helperRequest('/timezone/restore', (await helperRequest('/session')).token, {}), text('原始系统时区已恢复。', 'Original timezone restored.'))}>{text('恢复原始时区', 'Restore original timezone')}</button>}
      <ClaudeDesktopLaunch locale={locale} connected={connected} protectionEnabled={protectionEnabled} />
    </div>
    <BrowserCloakStatus report={browserReport} locale={locale} />
    <fieldset disabled={locked || (!traffic?.available && !traffic?.applied)} className="connection-settings__form">
      <legend>FlClash</legend>
      <label>{text('回程策略组', 'Upstream policy')}<select value={policy} onChange={event => setPolicy(event.target.value)}>{traffic?.groups.map(group => <option key={group}>{group}</option>)}</select></label>
      <div className="connection-settings__actions">
        <button type="button" className="repair-button" disabled={traffic?.applied} onClick={() => void perform(() => request('/traffic', { action: 'prepare', defaultPolicy: policy }), text('配置已准备，尚未应用。', 'Configuration prepared; not applied.'))}>{text('准备联动', 'Prepare')}</button>
        <button type="button" className="repair-button" disabled={traffic?.applied || !traffic?.prepared || !traffic?.controllerReady || policy !== traffic.defaultPolicy} onClick={() => void perform(() => request('/traffic', { action: 'apply' }), text('配置已写入，请在 FlClash 重新应用并启动当前配置，再刷新连接状态。', 'Configuration saved. Reapply and start it in FlClash, then refresh connection status.'))}>{text('写入联动配置', 'Write integration config')}</button>
        <button type="button" className="repair-button" disabled={!traffic?.applied || ['merge', 'conflict'].includes(traffic.recovery?.kind || '')} onClick={() => void perform(() => request('/traffic', { action: 'restore' }), text('FlClash 联动已解除并核验。', 'FlClash integration removed and verified.'))}>{traffic?.recovery?.kind === 'reload' ? text('检查恢复状态', 'Check recovery') : text('解除联动', 'Remove integration')}</button>
      </div>
    </fieldset>
    {traffic && <p className="workspace-meta" role="status">{traffic.detail}{traffic.stats ? text(` · 已转发 ${traffic.stats.http + traffic.stats.tunnels}，失败 ${traffic.stats.failed}`, ` · Forwarded ${traffic.stats.http + traffic.stats.tunnels}, failed ${traffic.stats.failed}`) : ''}</p>}
    {traffic?.applied && traffic.recovery && traffic.recovery.kind !== 'ready' && <div className="connection-settings__recovery" role="status">
      {traffic.recovery.kind === 'merge' && <p>{text('FlClash 配置已变化。可以保留当前修改，只解除 EnvGuardCC 联动。', 'The FlClash profile changed. Keep your changes while removing the integration.')}</p>}
      {traffic.recovery.kind === 'conflict' && <p>{traffic.recovery.reason || text('配置变化无法自动处理，请查看备份。', 'The changes cannot be resolved automatically. Review the backups.')}</p>}
      {traffic.recovery.kind === 'reload' && <p>{text('请在 FlClash 重新应用当前配置，然后检查恢复状态。期间请保持 EnvGuardCC 运行。', 'Reapply the current profile in FlClash, then check recovery. Keep EnvGuardCC running meanwhile.')}</p>}
      {traffic.recovery.kind === 'clean' && <p>{text('当前配置已没有本次联动。检查 FlClash 运行状态后即可解除联动。', 'This profile no longer contains the integration. Check the running FlClash state to finish.')}</p>}
      {['merge', 'conflict'].includes(traffic.recovery.kind) && !!traffic.recovery.changes?.length && <details><summary>{text('查看配置变化', 'View changed fields')}</summary><ul>{traffic.recovery.changes.map((change, index) => <li key={`${change.path}-${index}`}>{change.path} · {({ added: text('新增', 'added'), removed: text('移除', 'removed'), modified: text('修改', 'modified') })[change.change]}{(change.before !== undefined || change.after !== undefined) && `：${change.before ?? '—'} → ${change.after ?? '—'}`}</li>)}</ul><small>{text('显示字段路径和端口变化，其他配置值及凭据不显示。最多列出 30 项。', 'Field paths and port changes are shown; other values and credentials are hidden. Up to 30 changes are listed.')}</small></details>}
      {traffic.recovery.backupDir && <p className="workspace-meta">{text('恢复备份：', 'Recovery backup: ')}{traffic.recovery.backupDir}</p>}
      <div className="connection-settings__actions">
        {traffic.recovery.kind === 'merge' && <button type="button" className="repair-button" disabled={locked} onClick={() => void perform(() => request('/traffic', { action: 'restore-preserving-changes', fingerprint: traffic.recovery?.fingerprint }), text('已保留更改并解除联动。', 'Changes preserved and integration removed.'))}>{text('保留更改并解除联动', 'Keep changes and remove integration')}</button>}
        {traffic.recovery.kind === 'conflict' && traffic.recovery.originalValid && traffic.recovery.fingerprint && <button type="button" className="repair-button" disabled={locked} onClick={() => {
          if (window.confirm(text('这会用联动前的备份替换当前配置，之后的配置修改将不再生效。当前配置会先备份。确定继续吗？', 'This replaces the current profile with the pre-integration backup. Later changes will not take effect. The current profile will be backed up first. Continue?'))) void perform(() => request('/traffic', { action: 'restore-original', fingerprint: traffic.recovery?.fingerprint, confirm: true }), text('联动前备份已恢复。', 'Pre-integration backup restored.'));
        }}>{text('恢复联动前备份', 'Restore pre-integration backup')}</button>}
        {traffic.recovery.backupDir && <button type="button" className="repair-button repair-button--quiet" disabled={locked} onClick={() => void perform(() => request('/traffic', { action: 'open-recovery-backup' }), text('已打开恢复备份。', 'Recovery backup opened.'))}>{text('打开备份', 'Open backup')}</button>}
        <button type="button" className="repair-button repair-button--quiet" disabled={locked} onClick={() => void perform(() => request('/traffic', { action: 'open-flclash' }), text('请在 FlClash 中完成检查或重新应用配置。', 'Check or reapply the profile in FlClash.'))}>{text('打开 FlClash', 'Open FlClash')}</button>
      </div>
    </div>}
    <button type="button" className="repair-button repair-button--quiet" disabled={locked} onClick={() => void perform(async () => {}, text('连接状态已刷新。', 'Connection status refreshed.'))}>{text('刷新连接状态', 'Refresh connection status')}</button>
    {message && <p role="status">{message}</p>}
    {error && <p className="repair-feedback repair-feedback--error" role="alert">{error}</p>}
  </details>;
}
