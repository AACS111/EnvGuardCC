"use client";
import Image from 'next/image';
import { DocumentationDialog } from './DocumentationDialog';
import { AppUpdateNotice } from './AppUpdateNotice';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';
import type { TransferLogHandle } from './TransferLog';
import { TrafficFlow } from './TrafficFlow';
import { WorkspaceSettingsDialog, type SettingsSection } from './WorkspaceSettingsDialog';
import { NetCorePanel } from './NetCorePanel';
import { BrowserCloakStatus } from './BrowserCloakStatus';
import type { BrowserCloakExecution } from '@/detection/environment-runtime';
import { netCoreView } from '@/detection/net-core-view.mjs';
import type { ExitHistory, NetCoreExit, NetCoreNetworkState, NetCoreReport } from '@/detection/gateway-check';
import { describeExit } from '@/detection/exit-quality.mjs';
import { measurementStatus, measurementPoints } from '@/detection/measurement-status';
import { signalPolicy } from '@/detection/signal-policy';
import { partitionIssues, requirementLabel, signalRequirement } from '@/detection/signal-requirement';
import { verificationScores, verificationItem, verificationSampleStatus, environmentRiskEstimates } from '@/detection/verification-score';
import { EnvironmentIcon } from './EnvironmentIcon';
import { ScoreMeter } from './ScoreMeter';
import { exitNetworkType } from '@/detection/network-type';
import { useState, useSyncExternalStore, useRef } from 'react';
import type { SignalView } from '@/detection/client-engine';
import { windowsTimezoneFor, type ExitGeo, type ExitTarget } from '@/detection/exit-geo';
import type { ProtectionReport } from '@/detection/protection';
import type { LocaleCode } from '@/i18n/messages';
import type { ReactNode } from 'react';

export type Baseline = { at: string; browser: SignalView[]; claude: SignalView[]; score: number | null; policy: Record<string, unknown>; storage: Record<string, string | null> };
type Props = {
  locale: LocaleCode; report: ProtectionReport | null; connected: boolean; busy: boolean; checking?: boolean; powerAction?: "start" | "stop" | null; error?: string;
  scores: ReturnType<typeof verificationScores>;
  geo: ExitGeo | null; target: ExitTarget | null; baseline: Baseline | null;
  browser: SignalView[]; claude: SignalView[]; signals: SignalView[]; cards: ReactNode;
  filter: string; search: string; onFilter: (value: string) => void; onSearch: (value: string) => void;
  onToggle: () => void; onStop: () => void; onMonitor: (enabled: boolean, intervalMs: number) => void; onRefresh: () => void; onRepair?: () => void; onSelect: (id: string) => void;
  netCore: NetCoreReport | null; netCoreBusy?: boolean; netCoreError?: string;
  onNetCoreStrict?: (enabled: boolean) => void; onNetCoreTunnel?: (enabled: boolean) => void; onNetCoreRefresh: () => void; onNetCoreStart: () => void; onNetCoreStop: () => void; onNetCoreRestart: () => void; onNetCoreAuthorizeHost?: () => void; onNetCoreSelect: (name: string) => void; onNetCoreManageSources: () => void; onNetCoreAddSource?: () => void; onNetCoreOpenNetworkConfig: () => void; onNetCoreMeasure: () => void; onNetCoreModeChange: (mode: "rule" | "global" | "direct") => void; onNetCoreUnlockRegion?: () => void; onNetCoreNetworkFailure?: (policy: "claude" | "all") => void; netCoreMeasuring?: boolean; netCoreDelays?: Record<string, number | null>; netCoreExits?: Record<string, NetCoreExit | null>; netCoreExitsAt?: string | null; netCoreExiting?: boolean; onNetCoreProbeExits?: () => void; netCoreExitHistory?: ExitHistory | null; netCoreNetwork?: NetCoreNetworkState | null;
  browserCloak?: BrowserCloakExecution | null; linkingBrowser?: boolean; onLinkBrowser?: () => void; onOpenBrowserPicker?: () => void;
};
type WorkspaceNotice = { id: string; message: string; tone: 'info' | 'warning' | 'error'; action?: { label: string; onClick: () => void } };
const NOTICE_DISMISS_KEY = 'envguardcc.dismissed-workspace-notices';
const REPOSITORY = 'https://github.com/AACS111/EnvGuardCC';
const EMPTY_DISMISSED: string[] = [];
let dismissedRaw: string | null = null;
let dismissedCache: string[] = EMPTY_DISMISSED;
const dismissedListeners = new Set<() => void>();

function readDismissedNotices(): string[] {
  if (typeof window === 'undefined') return EMPTY_DISMISSED;
  const raw = window.localStorage.getItem(NOTICE_DISMISS_KEY);
  if (raw === dismissedRaw) return dismissedCache;
  dismissedRaw = raw;
  try {
    const parsed = JSON.parse(raw ?? '[]');
    dismissedCache = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : EMPTY_DISMISSED;
  } catch { dismissedCache = EMPTY_DISMISSED; }
  return dismissedCache;
}

function subscribeDismissedNotices(listener: () => void): () => void {
  dismissedListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === NOTICE_DISMISS_KEY) { dismissedRaw = null; listener(); }
  };
  window.addEventListener('storage', onStorage);
  return () => { dismissedListeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

function restoreDismissedNotices(): void {
  try { window.localStorage.removeItem(NOTICE_DISMISS_KEY); } catch { /* 忽略 */ }
  dismissedRaw = null;
  dismissedCache = EMPTY_DISMISSED;
  for (const listener of dismissedListeners) listener();
}

function dismissNotice(id: string): void {
  const next = [...new Set([...readDismissedNotices(), id])];
  try { window.localStorage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
  dismissedRaw = null;
  for (const listener of dismissedListeners) listener();
}

const serverDismissedNotices = () => EMPTY_DISMISSED;

const time = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour12: false }) : '—';
const compactNavigation = () => window.matchMedia('(max-width: 540px)').matches;
const subscribeNavigation = (onChange: () => void) => {
  const media = window.matchMedia('(max-width: 540px)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

export function ProtectionWorkspace(props: Props) {
  const { locale, report, connected, scores, geo, target, baseline, signals, cards } = props;
  const stopping = props.powerAction === "stop" || report?.phase === "stopping";
  const starting = props.powerAction === "start" || report?.phase === "starting";
  const checking = Boolean(props.checking) && !stopping && !starting;
  // 检测期间不再锁住全局按钮：只有启停与恢复这类会改系统状态的操作才算忙碌。
  const busy = props.busy || stopping || starting;
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const dismissedNotices = useSyncExternalStore(subscribeDismissedNotices, readDismissedNotices, serverDismissedNotices);
  const displayedExitIp = report?.target?.ip ?? geo?.ip;
  const currentExitGeo = geo?.ip && geo.ip === displayedExitIp ? geo : null;
  const networkType = exitNetworkType(currentExitGeo?.org, locale, currentExitGeo?.asn);
  const [tab, setTab] = useState('basic');
  const transferLogRef = useRef<TransferLogHandle>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [compareSide, setCompareSide] = useState<'browser' | 'claude'>('browser');
  const compact = useSyncExternalStore(subscribeNavigation, compactNavigation, () => false);
  const protectionEnabled = Boolean(report?.enabled);
  const turnOff = stopping || (!starting && (protectionEnabled || report?.phase === 'restore_failed'));
  const action = turnOff ? text('关闭环境防护', 'Stop environment protection') : text('启动环境防护', 'Start environment protection');
  const tabs = [['basic', text('概览', 'Overview')], ['network', text('网络', 'Network')], ['tests', text('测试项目', 'Test items')], ['compare', text('保护对比', 'Comparison')]];
  const kernel = netCoreView(props.netCore, { locale });
  const measured = signals.filter(signal => measurementStatus(signal.id, props.browser.find(item => item.id === signal.id), props.claude.find(item => item.id === signal.id)) === 'measured').length;
  const points = (signal: SignalView) => measurementPoints(signal.id, props.browser.find(item => item.id === signal.id), props.claude.find(item => item.id === signal.id));
  const failed = (signal: SignalView) => measurementStatus(signal.id, props.browser.find(item => item.id === signal.id), props.claude.find(item => item.id === signal.id)) === 'error';
  const result = (signal: SignalView) => verificationItem(signal.id, props.browser.find(item => item.id === signal.id), props.claude.find(item => item.id === signal.id));
  const issues = signals.filter(signal => points(signal) > 0 || result(signal) === 'failed');
  // 异常分三层：只有「可保护」才是保护失效；字体/Emoji 与链路问题单独呈现，避免误认为保护没生效。
  const { actionable, environment: environmentLimits, link: linkLimits } = partitionIssues(issues);
  const beyondProtection = [...environmentLimits, ...linkLimits];
  const risks = environmentRiskEstimates(props.browser, props.claude);
  const coverageText = (side: keyof typeof scores.coverage) => { const count = scores.coverage[side]; return text(`通过 ${count.passed} / ${count.possible} · 未判定 ${count.pending} · 未通过 ${count.failed}`, `Passed ${count.passed} / ${count.possible} · Unresolved ${count.pending} · Not passed ${count.failed}`); };
  const comparisonRows = signals.filter(signal => {
    const scope = signalPolicy(signal.id).scope;
    return scope === 'both' || scope === compareSide;
  }).map(signal => {
    const before = baseline?.[compareSide].find(item => item.id === signal.id);
    const after = props[compareSide].find(item => item.id === signal.id);
    const beforeStatus = verificationSampleStatus(before);
    const afterStatus = verificationSampleStatus(after);
    const sampled = (sample?: SignalView) => Boolean(sample?.value && sample.testedAt && Number.isFinite(Date.parse(sample.testedAt)));
    const hasBaseline = sampled(before) && (beforeStatus === 'passed' || beforeStatus === 'failed');
    const hasCurrent = sampled(after) && (afterStatus === 'passed' || afterStatus === 'failed');
    return { signal, before, after, afterStatus, hasBaseline, changed: hasBaseline && hasCurrent && before?.value !== after?.value };
  });
  const changedRows = comparisonRows.filter(row => row.changed);
  const attentionRows = comparisonRows.filter(row => row.afterStatus === 'failed' || (row.afterStatus === 'pending' && row.after?.testedAt));
  const missingRows = comparisonRows.filter(row => !row.hasBaseline);
  const unchangedRows = comparisonRows.filter(row => row.hasBaseline && !row.changed && row.afterStatus !== 'failed' && row.afterStatus !== 'pending');
  const value = (sample?: SignalView) => !sample ? text('未采样', 'Not sampled') : sample.assessment === 'not_applicable' ? text('不适用', 'N/A') : sample.testedAt && sample.value ? sample.value : text('未采样', 'Not sampled');
  const diffList = (items: typeof comparisonRows, empty: string) => items.length ? <div className="workspace-diff-list">{items.map(({ signal, before, after, afterStatus, hasBaseline }) => <div key={signal.id} className="workspace-diff-row"><h3>{signal.label}</h3><div className="workspace-diff-values"><span>{value(before)}</span><span aria-hidden="true">→</span><strong>{value(after)}</strong></div><div className="workspace-diff-actions"><span className="workspace-result" data-result={afterStatus}>{!hasBaseline ? text('缺少基线', 'Missing baseline') : afterStatus === 'passed' ? text('通过', 'Passed') : afterStatus === 'failed' ? text('未通过', 'Not passed') : afterStatus === 'not_applicable' ? text('不适用', 'N/A') : text('待确认', 'Unverified')}</span><button type="button" className="workspace-text-link" onClick={() => props.onSelect(signal.id)} aria-haspopup="dialog">{text('查看检测详情', 'View evidence')} →</button></div></div>)}</div> : <p className="workspace-meta">{empty}</p>;
  const issueSides = (signal: SignalView) => {
    const scope = signalPolicy(signal.id).scope;
    const browser = props.browser.find(item => item.id === signal.id);
    const client = props.claude.find(item => item.id === signal.id);
    const abnormal = (sample?: SignalView) => verificationSampleStatus(sample) === 'failed';
    return <span className="workspace-issue-sides">{scope !== 'claude' && abnormal(browser) && <span data-environment="browser"><EnvironmentIcon client={false} label={text('浏览器异常', 'Browser flagged')} /></span>}{scope !== 'browser' && abnormal(client) && <span data-environment="client"><EnvironmentIcon client label={text('客户端异常', 'Client flagged')} /></span>}</span>;
  };
  const restartNotice = report?.phase === 'restart_required' ? text('出口节点已变化，旧检测结果已过期。请先关闭保护，再启动保护，按最新出口 IP 生成匹配配置。', 'The exit node changed and previous results are stale. Stop protection, then start it again to generate settings for the latest exit IP.') : null;
  const error = props.error;

  const hostingWarning = props.target?.hosting
    ? text(`当前出口是云机房/托管 IP（${describeExit(props.target)}），Claude 可能拒绝登录；建议切换到住宅/原生 IP 节点。`, `The exit is a cloud/hosting IP (${describeExit(props.target)}); Claude may refuse login. Prefer a residential/native-IP node.`)
    : '';
  const targetTimezone = props.target?.timezone ?? report?.target?.timezone ?? null;
  const systemTimezone = report?.systemTimezone ?? null;
  const timezoneMismatch = Boolean(systemTimezone && targetTimezone && systemTimezone !== targetTimezone && systemTimezone !== windowsTimezoneFor(targetTimezone));
  const timezoneNotice = timezoneMismatch
    ? { id: 'system-timezone', message: text(`系统时区是 ${systemTimezone}，目标是 ${targetTimezone}；系统时区与出口地区不匹配，请重新应用修复。`, `System timezone is ${systemTimezone}, target is ${targetTimezone}. The system timezone does not match the exit region. Reapply protection to fix it.`), tone: 'error' as const, action: props.onRepair ? { label: text('重新应用并修复', 'Reapply and fix'), onClick: () => props.onRepair?.() } : undefined }
    : null;
  const unprotectedBlockError = !protectionEnabled && !starting && !stopping ? report?.unprotectedBlock?.error : null;
  const unprotectedBlocked = !protectionEnabled && !starting && !stopping && report?.unprotectedBlock?.active === true;
  const noticeItems = ([
    error ? { id: 'protection-error', message: error, tone: 'error' as const } : null,
    unprotectedBlockError ? { id: 'unprotected-block-error', message: text('未能阻断 Claude：', 'Claude was not blocked: ') + unprotectedBlockError, tone: 'error' as const } : null,
    unprotectedBlocked ? { id: 'unprotected-block', message: text('环境防护未开启，Claude 已被阻断；开启环境防护后才能继续使用 Claude。', 'Environment protection is off, so Claude is blocked. Enable environment protection to use Claude again.'), tone: 'error' as const } : null,
    timezoneNotice,
    !connected ? { id: 'disconnected', message: text('本机服务未连接，请先启动本机服务。', 'Local service disconnected. Start the local service first.'), tone: 'error' as const } : null,
    report?.phase === 'restore_failed' ? { id: 'restore-failed', message: text('配置恢复未完成，备份已保留。请点击“关闭保护”重试恢复。', 'Restoration incomplete. Backup retained; select Stop protection to retry restoration.'), tone: 'error' as const } : null,
    report?.alarm ? { id: 'score-alarm', message: text('验证得分较上次有效检测下降至少40%，请查看异常项目。', 'Verification score dropped at least 40% since the previous valid check. Review the flagged items.'), tone: 'error' as const } : null,
    restartNotice ? { id: 'restart-required', message: restartNotice, tone: 'error' as const } : null,
    hostingWarning ? { id: 'hosting-exit', message: hostingWarning, tone: 'warning' as const } : null,
  ] as (WorkspaceNotice | null)[]).filter((item): item is WorkspaceNotice => item !== null && !(item.tone === 'warning' && dismissedNotices.includes(item.id)));
  const noticeTone = noticeItems.some((item) => item.tone === 'error') ? 'error' : noticeItems.some((item) => item.tone === 'warning') ? 'warning' : 'info';

  return <section className="protection-workspace">
    <header className="workspace-global">
      <div className="workspace-brand"><Image className="workspace-brandmark" src="/envguardcc-icon.png" alt="" width={32} height={32} /><strong>EnvGuardCC</strong></div>
      <div className="workspace-header-actions">
        <button type="button" className="repair-button workspace-mobile-settings" aria-label={text('设置', 'Settings')} aria-haspopup="dialog" onClick={() => setSettingsSection('general')}><WorkspaceIcon name="settings" /></button>
        <span className="workspace-connection" data-connected={connected}><span aria-hidden="true" />{connected ? text('本机服务已连接', 'Local service connected') : text('本机服务未连接', 'Local service disconnected')}</span>
        <button type="button" className="repair-button repair-button--primary" disabled={busy || checking} aria-busy={checking} onClick={props.onRefresh}>{checking ? text('检测中…', 'Checking…') : text('检测', 'Check')}</button>
        <button type="button" className="repair-button workspace-power" data-enabled={protectionEnabled} disabled={busy || !connected || !report} onClick={turnOff ? props.onStop : props.onToggle} aria-busy={stopping || starting} aria-label={text('环境防护：', 'Environment protection: ') + action}>{action}</button>
      </div>
    </header>
    <aside className="workspace-sidebar">
      <div className="workspace-side-label">{text('工作台', 'Workspace')}</div>
      <div className="workspace-tabs" role="tablist" aria-orientation={compact ? 'horizontal' : 'vertical'} aria-label={text('工作区页面', 'Workspace pages')}>
        {tabs.map(([id, label], index) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => {
          const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setTab(tabs[next][0]); document.getElementById(`tab-${tabs[next][0]}`)?.focus(); }
        }}><WorkspaceIcon name={id as WorkspaceIconName} /><span className="workspace-tab-label">{label}</span>{id === 'tests' && <span className="workspace-nav-count">{signals.length}</span>}{id === 'network' && kernel.violationCount > 0 && <span className="workspace-nav-count">{kernel.violationCount}</span>}</button>)}
      </div>
      <div className="workspace-side-footer">
        <AppUpdateNotice locale={locale} connected={connected} />
        <button type="button" className="workspace-text-link" aria-haspopup="dialog" onClick={() => setSettingsSection('general')}><WorkspaceIcon name="settings" />{text('设置', 'Settings')}</button>
        <div className="workspace-side-links">
          <button type="button" className="workspace-text-link" aria-haspopup="dialog" onClick={() => setDocsOpen(true)}><WorkspaceIcon name="document" />{text('使用文档', 'Documentation')}</button>
          <a className="workspace-text-link" href={REPOSITORY} target="_blank" rel="noreferrer"><WorkspaceIcon name="github" />{text('项目地址', 'Repository')}</a>
        </div>
        <span>{text('Claude 检测与保护', 'Claude checks & protection')}</span>
      </div>
    </aside>
    <div className="workspace-main">
      <div className="workspace-content">
        <header className="workspace-page-heading">
          <div><h1>{tabs.find(([id]) => id === tab)?.[1]}</h1>
            <div className="workspace-flow-status" data-tone={kernel.tone}><span aria-hidden="true" />{kernel.conclusion.title}</div>
            <p className="workspace-flow-description">{text('以已观测连接为准，未覆盖全部系统流量', 'Observed connections only; not all system traffic')}</p>
          </div>
          <TrafficFlow report={props.netCore} protectionEnabled={protectionEnabled} locale={locale} onDetails={() => setTab('network')} onConnection={record => { setTab('network'); transferLogRef.current?.open(record); }} onRoute={route => { setTab('network'); transferLogRef.current?.openRoute(route); }} />
        </header>
        {noticeItems.length > 0 && <div className="workspace-notices" data-tone={noticeTone} role={noticeTone === 'error' ? 'alert' : 'status'} aria-live={noticeTone === 'error' ? 'assertive' : 'polite'}>
          {noticeItems.map((notice) => <div key={notice.id} className="workspace-alert" data-tone={notice.tone}>
            <p>{notice.message}</p>
            {notice.action && <button type="button" className="workspace-alert__action" onClick={notice.action.onClick}>{notice.action.label}</button>}
            {notice.tone === 'warning' && <button type="button" className="workspace-alert__dismiss" aria-label={text('不再提示这条提醒', 'Dismiss this notice')} title={text('不再提示', 'Dismiss')} onClick={() => dismissNotice(notice.id)}>×</button>}
          </div>)}
        </div>}
        {props.netCore?.regionLock?.locked && (() => {
          const lock = props.netCore.regionLock;
          // 自动恢复期间也允许立即复检，复用主动检测并解除锁定的入口。
          const auto = lock.type === 'network' || lock.autoRecover === true;
          const attempts = Number.isInteger(lock.recheckAttempts) ? lock.recheckAttempts : 0;
          return <div className="workspace-notices" data-tone="error" role="alert">
            <p className="workspace-alert" data-tone="error">{lock.reason || text('固定出口未通过复检，Claude 流量已阻断。', 'The pinned exit failed recheck; Claude traffic is blocked.')}</p>
            {auto && <p className="workspace-alert" data-tone="info" role="status">{text(`正在自动复检${attempts ? `（第 ${attempts} 次）` : ''}，网络恢复后自动解除；也可点击“立即复检”主动检测。`, `Automatic recheck${attempts ? ` (attempt ${attempts})` : ''} is running and will unlock when the network recovers. You can also select “Recheck now” to check immediately.`)}</p>}
            {props.netCoreError && <p className="workspace-alert" data-tone="error">{props.netCoreError}</p>}
            <button type="button" className="repair-button" onClick={() => props.onNetCoreUnlockRegion?.()} disabled={Boolean(props.netCoreBusy) || busy || !props.onNetCoreUnlockRegion} aria-busy={props.netCoreBusy || undefined}>{props.netCoreBusy ? text('复检中…', 'Rechecking…') : auto ? text('立即复检', 'Recheck now') : text('复检并解除', 'Recheck and unlock')}</button>
          </div>;
        })()}
        <div id="panel-basic" role="tabpanel" aria-labelledby="tab-basic" tabIndex={0} hidden={tab !== 'basic'}>
          <section className="workspace-panel workspace-hero">
            <div><span className="netcore-pill" data-tone={protectionEnabled ? 'ok' : 'muted'}>{protectionEnabled ? text('环境防护运行中', 'Environment protection is on') : text('环境防护未开启', 'Environment protection is off')}</span>
              <h2>{starting ? text('正在启动环境防护', 'Starting environment protection') : stopping ? text('正在关闭并恢复配置', 'Stopping and restoring settings') : protectionEnabled ? (noticeItems.length ? text(`防护已开启，有 ${noticeItems.length} 项运行提醒`, `Protection is on, with ${noticeItems.length} notices`) : text('防护已开启，查看检测结果确认状态', 'Protection is on; review results to verify')) : text('开启防护，适配当前出口环境', 'Enable protection for your current exit')}</h2>
              <p>{kernel.conclusion.detail}</p>
            </div><button type="button" className="repair-button" onClick={() => { props.onFilter('all'); props.onSearch(''); setTab('tests'); }}>{text('查看检测结果', 'View results')} →</button>
          </section>
          <section className="workspace-score" aria-label={text('环境验证得分', 'Environment verification scores')}>
            <div className="workspace-section-heading"><h2>{text('环境检测得分', 'Environment check scores')}</h2><button type="button" className="workspace-text-link" onClick={() => setTab('tests')}>{text('查看检测项', 'View test items')} →</button></div>
            <div className="workspace-score-sides">{(['browser', 'claude'] as const).map(side => {
              const count = scores.coverage[side];
              return <div key={side}>
                <div className="workspace-score-heading"><h3><EnvironmentIcon client={side === 'claude'} label={side === 'browser' ? text('浏览器', 'Browser') : text('客户端', 'Client')} />{side === 'browser' ? text('浏览器', 'Browser') : text('客户端', 'Client')}</h3>{count.failed > 0 && <button type="button" className="workspace-failure-link" onClick={() => { props.onFilter('issues'); props.onSearch(''); setTab('tests'); }}>{text(`${count.failed} 项未通过`, `${count.failed} not passed`)} →</button>}</div>
                <ScoreMeter normalized value={count.passed + count.failed > 0 ? scores[side] : null} label={text('加权检测得分', 'Weighted check score')} pending={text('尚未检测', 'Not tested')} summary={coverageText(side)} maximum={count.maximum} />
              </div>;
            })}</div>
            <div className="workspace-score-explanation"><p>{text('按项目权重折算，满分 100；未判定项暂计半分。检测得分不能推算账号封禁概率。', 'Weighted score out of 100; unresolved items receive half credit. Scores do not predict account bans.')}</p><p>{text(`可由环境防护处理的异常：${actionable.length}；保护范围外项目单独列示。`, `Protectable issues: ${actionable.length}; items outside protection are listed separately.`)}</p></div>
          </section>
          <div className="workspace-overview-grid">
            <section className="workspace-panel workspace-summary-card"><h3><WorkspaceIcon name="globe" />{text('当前出口', 'Current exit')}</h3><div className="workspace-summary-value">{report?.target?.countryName ?? geo?.countryName ?? text('未识别', 'Unknown')}{(report?.target?.city ?? geo?.city) ? ` · ${report?.target?.city ?? geo?.city}` : ''}</div><p>{displayedExitIp ?? text('尚未采样', 'Not sampled')} · <button type="button" className="workspace-text-link" onClick={() => setTab('network')}>{text('管理网络', 'Manage network')} →</button></p><p title={networkType.detail}>{networkType.label} · {geo?.org ?? geo?.asn ?? '—'}</p><button className="workspace-text-link" type="button" disabled={busy || checking} aria-busy={checking} onClick={props.onRefresh}>{checking ? text('检测中…', 'Checking…') : text('刷新', 'Refresh')}</button></section>
            <section className="workspace-panel workspace-summary-card"><h3><WorkspaceIcon name="sliders" />{text('目标环境', 'Target environment')}</h3><div className="workspace-summary-value">{report?.target?.timezone ?? target?.timezone ?? '—'}</div><p>{text('系统时区', 'System timezone')} {systemTimezone ?? '—'}{timezoneMismatch && <span className="workspace-field-warning"> · {text('与目标不一致', 'Mismatch')}</span>}</p><p>{text('语言 / 区域', 'Language / locale')} {report?.target?.language ?? target?.language ?? '—'}</p><p>{text('配置目标与实测结果分别呈现', 'Configuration and measurements are shown separately')}</p></section>
            <section className="workspace-panel workspace-summary-card workspace-browser-card"><h3><WorkspaceIcon name="browser" />{text('浏览器保护', 'Browser protection')}</h3><BrowserCloakStatus report={props.browserCloak ?? null} locale={locale} /><div className="workspace-browser-actions"><button type="button" className="repair-button repair-button--primary" disabled={busy || props.linkingBrowser || !props.onLinkBrowser} onClick={() => props.onLinkBrowser?.()}>{props.linkingBrowser ? text('启动中…', 'Starting…') : text('启动保护浏览器', 'Launch protected browser')}</button><button type="button" className="repair-button" disabled={busy || !props.onOpenBrowserPicker} onClick={props.onOpenBrowserPicker} aria-haspopup="dialog">{text('选择浏览器', 'Choose browser')}</button></div></section>
          </div>
          <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('需要关注', 'Needs attention')}<span className="workspace-heading-count">{actionable.length}</span></h2><button type="button" className="repair-button repair-button--quiet" onClick={() => { props.onFilter('issues'); props.onSearch(''); setTab('tests'); }}>{text('查看全部', 'View all')} →</button></div>{actionable.length ? <div className="workspace-issue-list">{actionable.slice(0, 6).map((signal) => <button type="button" key={signal.id} onClick={() => props.onSelect(signal.id)}><span className="workspace-issue-name">{signal.label}{issueSides(signal)}</span><span>{failed(signal) ? text("检测失败", "Failed") : text('未通过', 'Not passed')} →</span></button>)}</div> : <p>{measured ? text('可保护项暂无异常', 'No protectable items flagged') : text('尚未检测，请启动保护或刷新环境。', 'Start protection or refresh to run tests.')}</p>}
            {beyondProtection.length > 0 && <details className="workspace-details" data-beyond-protection={beyondProtection.length}>
              <summary>{text(`保护范围外 · ${beyondProtection.length}`, `Outside protection · ${beyondProtection.length}`)}</summary>
              <p className="workspace-meta">{text('这些项不是声明面能改的：字体/Emoji 是系统事实，出口与可达性取决于节点和网络。', 'These are not declaration-layer items: fonts and emoji are system facts; exit and reachability depend on the node and network.')}</p>
              <ul>{beyondProtection.map((signal) => <li key={signal.id}><button type="button" className="workspace-issue-name" onClick={() => props.onSelect(signal.id)}>{signal.label}</button><span className="workspace-meta">{requirementLabel(zh, signalRequirement(signal.id))}</span></li>)}</ul>
            </details>}</section>
          <details className="workspace-panel workspace-details"><summary>{text('能力范围与检测方法', 'Scope and detection methods')}</summary><p>{text('字体 / Emoji 渲染取决于系统；出口类型取决于节点。检测结果仅反映本次采样。', 'Fonts and emoji depend on the system; exit type depends on the node. Results reflect this sample only.')}</p><dl className="workspace-fields">{(['browser', 'claude'] as const).map(side => <div key={side}><dt>{side === 'browser' ? text('浏览器环境风险估计', 'Estimated browser environment risk') : text('客户端环境风险估计', 'Estimated client environment risk')}</dt><dd>{risks[side].value === null ? '—' : `${risks[side].value}%`} · {text('已测权重', 'Measured weight')} {risks[side].observedWeight} / {risks[side].totalWeight}</dd></div>)}</dl><p>{text('环境风险估计是检测指标，非真实封禁概率。', 'Estimated environment risk is a detection indicator, not a ban probability.')}</p></details>
          {Boolean(report?.issues.length) && <details className="workspace-panel workspace-details"><summary>{text('执行详情', 'Operation details')} · {report!.issues.length}</summary><ul>{report!.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
        </div>
        <div id="panel-network" role="tabpanel" aria-labelledby="tab-network" tabIndex={0} hidden={tab !== 'network'}>
          <NetCorePanel locale={locale} report={props.netCore} visible={tab === 'network'} transferLogRef={transferLogRef} busy={Boolean(props.netCoreBusy) || busy} error={props.netCoreError} onRefresh={props.onNetCoreRefresh} onOpenSettings={() => setSettingsSection('network')} onRestart={props.onNetCoreRestart} onSelectNode={props.onNetCoreSelect} onMeasure={props.onNetCoreMeasure} onModeChange={props.onNetCoreModeChange} measuring={props.netCoreMeasuring} delays={props.netCoreDelays} exits={props.netCoreExits ?? {}} exitsAt={props.netCoreExitsAt ?? null} probingExits={props.netCoreExiting} onProbeExits={props.onNetCoreProbeExits} exitHistory={props.netCoreExitHistory ?? null} />
        </div>
        <div id="panel-tests" role="tabpanel" aria-labelledby="tab-tests" tabIndex={0} hidden={tab !== 'tests'}>
          <section className="workspace-panel workspace-test-overview"><div className="workspace-section-heading"><h2>{text('检测结果', 'Test results')}</h2><span className="netcore-pill">{text(`检测目录 · ${signals.length} 项`, `Test catalog · ${signals.length} items`)}</span></div><div className="workspace-test-coverage">{(['browser', 'claude'] as const).map(side => <div key={side}><strong>{side === 'browser' ? text('浏览器', 'Browser') : text('客户端', 'Client')}</strong><span>{coverageText(side)}</span></div>)}</div><p>{text('绿色表示通过，红色表示未通过；未判定与不适用分别标注。', 'Green indicates passed; red indicates not passed. Unresolved and inapplicable results are labeled separately.')}</p></section>
          <div className="workspace-toolbar"><div className="workspace-filters" role="group" aria-label={text('检测状态筛选', 'Filter tests')}>{[['all',text('全部','All')],['issues',text('异常','Issues')],['pending',text('未判定','Unresolved')],['passed',text('通过','Passed')]].map(([id,label]) => <button key={id} className="repair-button repair-button--quiet" type="button" aria-pressed={props.filter === id} onClick={() => props.onFilter(id)}>{label}</button>)}</div><input type="search" aria-label={text('搜索检测项','Search tests')} placeholder={text('搜索检测项','Search tests')} value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></div>
          <div className="workspace-test-summary"><p className="workspace-meta">{text(`已测 ${measured} / ${signals.length} · 可保护 ${actionable.length} · 保护范围外 ${beyondProtection.length} · 未判定 ${signals.length - measured}`, `Measured ${measured} / ${signals.length} · Protectable ${actionable.length} · Outside ${beyondProtection.length} · Unresolved ${signals.length - measured}`)}</p><div className="workspace-legend" aria-label={text('检测状态图例', 'Test status legend')}><span data-kind="measured">{text('原生通过', 'Native pass')}</span><span data-kind="simulated">{text('保护后通过', 'Protected pass')}</span><span data-kind="flagged">{text('异常', 'Flagged')}</span><span data-kind="pending">{text('未判定', 'Unresolved')}</span><span className="workspace-source-legend" data-environment="browser"><EnvironmentIcon client={false} label={text('浏览器', 'Browser')} />{text('浏览器', 'Browser')}</span><span className="workspace-source-legend" data-environment="client"><EnvironmentIcon client label={text('客户端', 'Client')} />{text('客户端', 'Client')}</span></div></div>
          {cards}
        </div>
        <div id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" tabIndex={0} hidden={tab !== 'compare'}>
          <section className="workspace-panel workspace-compare-overview"><div className="workspace-section-heading"><h2>{text('本次保护带来的变化', 'Changes during this protection session')}</h2><span className="netcore-pill">{text('同一会话', 'Same session')}</span></div><div className="workspace-compare-period"><div><span>{text('启动前 · 基线', 'Before activation · baseline')}</span><strong>{time(baseline?.at)}</strong></div><span aria-hidden="true">→</span><div><span>{text('当前检测', 'Current check')}</span><strong>{time(report?.lastTestAt)}</strong></div></div><div className="workspace-compare-counts"><div><span>{text('检测到变化', 'Changed')}</span><strong>{baseline ? changedRows.length : '—'}</strong></div><div><span>{text('仍需关注', 'Needs attention')}</span><strong>{attentionRows.length}</strong></div><div><span>{text('缺少基线', 'Missing baseline')}</span><strong>{missingRows.length}</strong></div></div><p>{text('仅对比前后均有采样的实测值；变化数量不代表保护成功率。', 'Only sampled measurements can establish a change; change counts are not a success rate.')}</p></section>
          <div className="workspace-toolbar"><div className="workspace-filters" role="group" aria-label={text('对比环境', 'Comparison environment')}>{(['browser', 'claude'] as const).map(side => <button key={side} type="button" className="repair-button" aria-pressed={compareSide === side} onClick={() => setCompareSide(side)}>{side === 'browser' ? text('浏览器', 'Browser') : text('客户端', 'Client')}</button>)}</div><label className="workspace-monitor"><input type="checkbox" role="switch" checked={onlyChanges} onChange={event => setOnlyChanges(event.target.checked)} />{text('只看差异与未通过项', 'Only changes and unresolved items')}</label></div>
          {!baseline && <section className="workspace-panel"><p>{text('启动保护后查看前后对比。', 'Start protection to capture a baseline and compare results.')}</p></section>}
          <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('已检测到的变化', 'Observed changes')}</h2><span className="netcore-pill" data-tone="ok">{text('前后均有采样', 'Both sides sampled')}</span></div>{diffList(changedRows, text('当前没有前后均已采样的变化。', 'No changes with both measurements available.'))}</section>
          <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('仍需关注', 'Needs attention')}</h2><span className="netcore-pill" data-tone="warn">{text('能力范围与未通过项', 'Scope and unresolved items')}</span></div>{diffList(attentionRows, text('当前没有需关注的项目。', 'No items require attention.'))}</section>
          <details className="workspace-panel workspace-details"><summary>{text('缺少基线', 'Missing baseline')} · {missingRows.length}</summary><p>{text('启动前没有有效采样，无法判断是否发生变化。', 'No valid sample before activation; changes cannot be determined.')}</p>{diffList(missingRows, text('所有项目均有基线。', 'All items have a baseline.'))}</details>
          {onlyChanges ? <details className="workspace-panel workspace-details"><summary>{text('未变化项目', 'Unchanged items')} · {unchangedRows.length}</summary>{diffList(unchangedRows, text('没有未变化项目。', 'No unchanged items.'))}</details> : <section className="workspace-panel"><h2>{text('未变化项目', 'Unchanged items')}</h2>{diffList(unchangedRows, text('没有未变化项目。', 'No unchanged items.'))}</section>}
          <details className="workspace-panel workspace-details"><summary>{text('检测与恢复记录','Test and restoration history')}{report?.history.length ? ` · ${report.history.length}` : ''}</summary>{report?.history.length ? <ol className="workspace-history">{report.history.map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{time(event.at)}</time><span>{event.message}</span></li>)}</ol> : <p>{text('暂无记录','No events yet')}</p>}</details>
        </div>
        <footer className="workspace-footer"><span>{text('本机会话 · 检测结果仅反映采样时的环境', 'Local session · results reflect the sampled environment')}</span><span>{text('环境设置与实际验证分别呈现', 'Configuration and verification are shown separately')}</span></footer>
      </div>
    </div>
    {settingsSection && <WorkspaceSettingsDialog locale={locale} initialSection={settingsSection} onClose={() => setSettingsSection(null)} report={report} connected={connected} busy={busy} onMonitor={props.onMonitor} dismissedNoticeCount={dismissedNotices.length} onRestoreNotices={restoreDismissedNotices}
      network={{ locale, report: props.netCore, busy: Boolean(props.netCoreBusy) || busy, error: props.netCoreError, tunnelLocked: protectionEnabled, networkState: props.netCoreNetwork, onStart: props.onNetCoreStart, onStop: props.onNetCoreStop, onRestart: props.onNetCoreRestart, onTunnelChange: props.onNetCoreTunnel, onStrictChange: props.onNetCoreStrict, onNetworkFailureChange: props.onNetCoreNetworkFailure, onManageSources: props.onNetCoreManageSources, onAddSource: props.onNetCoreAddSource, onOpenNetworkConfig: props.onNetCoreOpenNetworkConfig, onAuthorizeHost: props.onNetCoreAuthorizeHost }} />}
    {docsOpen && <DocumentationDialog locale={locale} onClose={() => setDocsOpen(false)} />}
  </section>;
}
