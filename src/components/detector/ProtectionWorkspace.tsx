"use client";
import Image from 'next/image';
import { DesktopSettingsFields } from './DesktopSettingsFields';
import { NetCorePanel } from './NetCorePanel';
import { BrowserCloakStatus } from './BrowserCloakStatus';
import type { BrowserCloakExecution } from '@/detection/environment-runtime';
import { netCoreView } from '@/detection/net-core-view.mjs';
import type { ExitHistory, NetCoreNetworkState, NetCoreReport } from '@/detection/gateway-check';
import { measurementStatus, measurementPoints } from '@/detection/measurement-status';
import { signalPolicy } from '@/detection/signal-policy';
import { partitionIssues, requirementLabel, signalRequirement } from '@/detection/signal-requirement';
import { verificationScores, verificationItem, verificationSampleStatus, environmentRiskEstimates } from '@/detection/verification-score';
import { EnvironmentIcon } from './EnvironmentIcon';
import { ScoreMeter } from './ScoreMeter';
import { exitNetworkType } from '@/detection/network-type';
import { useState, useSyncExternalStore } from 'react';
import type { SignalView } from '@/detection/client-engine';
import type { ExitGeo, ExitTarget } from '@/detection/exit-geo';
import type { ProtectionReport } from '@/detection/protection';
import type { LocaleCode } from '@/i18n/messages';
import type { CSSProperties, ReactNode } from 'react';

export type Baseline = { at: string; browser: SignalView[]; claude: SignalView[]; score: number | null; policy: Record<string, unknown>; storage: Record<string, string | null> };
type Props = {
  locale: LocaleCode; report: ProtectionReport | null; connected: boolean; busy: boolean; checking?: boolean; powerAction?: "start" | "stop" | null; error?: string;
  scores: ReturnType<typeof verificationScores>;
  geo: ExitGeo | null; target: ExitTarget | null; baseline: Baseline | null;
  browser: SignalView[]; claude: SignalView[]; signals: SignalView[]; cards: ReactNode;
  filter: string; search: string; onFilter: (value: string) => void; onSearch: (value: string) => void;
  onToggle: () => void; onStop: () => void; onMonitor: (enabled: boolean, intervalMs: number) => void; onRefresh: () => void; onSelect: (id: string) => void;
  netCore: NetCoreReport | null; netCoreBusy?: boolean; netCoreError?: string;
  onNetCoreRefresh: () => void; onNetCoreRestart: () => void; onNetCoreSelect: (name: string) => void; onNetCoreAddConfig: () => void; onNetCoreEditConfig?: () => void; onNetCoreOpenNetworkConfig: () => void; onNetCoreRefreshSubscription: () => void; onNetCoreMeasure: () => void; onNetCoreModeChange: (mode: "claude" | "rule" | "global" | "direct") => void; netCoreMeasuring?: boolean; netCoreDelays?: Record<string, number | null>; netCoreExits?: Record<string, { countryCode: string | null; country: string | null; ip: string | null } | null>; netCoreExiting?: boolean; onNetCoreProbeExits?: () => void; netCoreExitHistory?: ExitHistory | null; netCoreNetwork?: NetCoreNetworkState | null;
  browserCloak?: BrowserCloakExecution | null; linkingBrowser?: boolean; onLinkBrowser?: () => void; onOpenBrowserPicker?: () => void;
};
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
  const displayedExitIp = report?.target?.ip ?? geo?.ip;
  const currentExitGeo = geo?.ip && geo.ip === displayedExitIp ? geo : null;
  const networkType = exitNetworkType(currentExitGeo?.org, locale, currentExitGeo?.asn);
  const [tab, setTab] = useState('basic');
  const [onlyChanges, setOnlyChanges] = useState(true);
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
  const intervalMs = report?.intervalMs ?? 60000;
  const risks = environmentRiskEstimates(props.browser, props.claude);
  const coverageText = (side: keyof typeof scores.coverage) => { const count = scores.coverage[side]; return text(`通过 ${count.passed} / ${count.possible} · 未判定 ${count.pending} · 未通过 ${count.failed}`, `Passed ${count.passed} / ${count.possible} · Unresolved ${count.pending} · Not passed ${count.failed}`); };
  const rows = signals.map((signal) => {
    const beforeBrowser = baseline?.browser.find((item) => item.id === signal.id);
    const beforeClaude = baseline?.claude.find((item) => item.id === signal.id);
    const afterBrowser = props.browser.find((item) => item.id === signal.id);
    const afterClaude = props.claude.find((item) => item.id === signal.id);
    const status = measurementStatus(signal.id, afterBrowser, afterClaude);
    return { signal, beforeBrowser, beforeClaude, afterBrowser, afterClaude, status, changed: beforeBrowser?.value !== afterBrowser?.value || beforeClaude?.value !== afterClaude?.value, verified: verificationItem(signal.id, afterBrowser, afterClaude) === 'passed' };
  }).filter((row) => !onlyChanges || row.changed || points(row.signal) > 0 || !row.verified);
  const value = (sample?: SignalView) => !sample ? '—' : sample.testedAt && sample.value ? sample.value : text('未采样', 'Not sampled');
  const pair = (id: string, browser?: SignalView, client?: SignalView) => <span className="workspace-pair"><span data-environment="browser"><EnvironmentIcon client={false} label={text('浏览器', 'Browser')} /><span>{value(signalPolicy(id).scope === 'claude' ? undefined : browser)}</span></span><span data-environment="client"><EnvironmentIcon client label={text('客户端', 'Client')} /><span>{value(signalPolicy(id).scope === 'browser' ? undefined : client)}</span></span></span>;
  const issueSides = (signal: SignalView) => {
    const scope = signalPolicy(signal.id).scope;
    const browser = props.browser.find(item => item.id === signal.id);
    const client = props.claude.find(item => item.id === signal.id);
    const abnormal = (sample?: SignalView) => verificationSampleStatus(sample) === 'failed';
    return <span className="workspace-issue-sides">{scope !== 'claude' && abnormal(browser) && <span data-environment="browser"><EnvironmentIcon client={false} label={text('浏览器异常', 'Browser flagged')} /></span>}{scope !== 'browser' && abnormal(client) && <span data-environment="client"><EnvironmentIcon client label={text('客户端异常', 'Client flagged')} /></span>}</span>;
  };
  const restartNotice = report?.phase === 'restart_required' ? text('出口节点已变化，旧检测结果已过期。请先关闭保护，再启动保护，按最新出口 IP 生成匹配配置。', 'The exit node changed and previous results are stale. Stop protection, then start it again to generate settings for the latest exit IP.') : null;
  const error = props.error;
  const total = scores.combined;
  const notices = [...new Set([
    error, restartNotice,
    !connected ? text('本机服务未连接，请先启动本机服务。', 'Local service disconnected. Start the local service first.') : '',
    report?.alarm ? text('验证得分较上次有效检测下降至少40%，请查看异常项目。', 'Verification score dropped at least 40% since the previous valid check. Review the flagged items.') : '',
    report?.phase === 'restore_failed' ? text('配置恢复未完成，备份已保留。请点击“关闭保护”重试恢复。', 'Restoration incomplete. Backup retained; select Stop protection to retry restoration.') : '',
  ])].filter((message): message is string => Boolean(message));

  return <section className="protection-workspace">
    <aside className="workspace-sidebar">
      <div className="workspace-brand"><Image src="/envguardcc-icon.png" alt="" width={32} height={32} />EnvGuardCC<span>{text('环境工作台', 'Environment workspace')}</span></div>
      <div className="workspace-tabs" role="tablist" aria-orientation={compact ? 'horizontal' : 'vertical'} aria-label={text('工作区页面', 'Workspace pages')}>
        {tabs.map(([id, label], index) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => {
          const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setTab(tabs[next][0]); document.getElementById(`tab-${tabs[next][0]}`)?.focus(); }
        }}>{label}{id === 'tests' && <span className="workspace-nav-count">{signals.length}</span>}{id === 'network' && kernel.violationCount > 0 && <span className="workspace-nav-count">{kernel.violationCount}</span>}</button>)}
      </div>
      <div className="workspace-connection" data-connected={connected}><span aria-hidden="true" />{connected ? text('本机服务已连接', 'Local service connected') : text('本机服务未连接', 'Local service disconnected')}</div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-header">
        <h1>{tabs.find(([id]) => id === tab)?.[1]}</h1>
        <div className="workspace-header-actions">
          <span className="netcore-pill" data-tone={kernel.tone} title={kernel.conclusion.title}>{kernel.label}</span>
          <button type="button" className="repair-button repair-button--quiet" disabled={busy || checking} aria-busy={checking} onClick={props.onRefresh}>{checking ? text('检测中…', 'Checking…') : text('检测', 'Check')}</button>
          <button type="button" className="repair-button workspace-power" data-enabled={protectionEnabled} disabled={busy || !connected || !report} onClick={turnOff ? props.onStop : props.onToggle} aria-busy={stopping || starting} aria-label={text('环境防护：', 'Environment protection: ') + action}>{action}</button>
        </div>
      </header>
      <div className="workspace-content">
        {notices.length > 0 && <div className="workspace-notices" role="alert">{notices.map((message) => <p key={message} className="workspace-alert">{message}</p>)}</div>}
        <div id="panel-basic" role="tabpanel" aria-labelledby="tab-basic" tabIndex={0} hidden={tab !== 'basic'}>
          <section className="workspace-score" aria-label={text('环境验证得分', 'Environment verification scores')}>
            <div className="workspace-score-total"><span>{text('环境风险估计', 'Estimated environment risk')}</span><div className="workspace-risk-rings">{(['browser', 'claude'] as const).map(side => {
              const estimate = risks[side];
              const value = estimate.value;
              const label = side === 'browser' ? text('浏览器', 'Browser') : text('客户端', 'Client');
              return <div key={side} className="workspace-risk-item"><div className="workspace-risk-ring" data-pending={value === null} role="img" aria-label={label + (value === null ? text('：未测得', ': not measured') : text('环境风险估计：', ' estimated environment risk: ') + value + '%')} style={{ '--risk-percent': (value ?? 0) + '%' } as CSSProperties}><strong>{value === null ? '—' : value + '%'}</strong></div><span>{label}</span><small>{text('已测权重 ', 'Measured weight ')}{estimate.observedWeight} / {estimate.totalWeight}</small></div>;
            })}</div><p className="workspace-risk-disclaimer">{text('检测指标，非真实封禁概率', 'Detection indicator, not an account-ban probability')}</p></div>
            <div className="workspace-score-sides"><div data-environment="browser"><ScoreMeter value={scores.browser} label={<><EnvironmentIcon client={false} label={text('浏览器', 'Browser')} />{text('浏览器', 'Browser')}</>} pending={text('浏览器未检测', 'Browser not tested')} summary={coverageText('browser')} maximum={scores.coverage.browser.maximum} /></div><div data-environment="client"><ScoreMeter value={scores.claude} label={<><EnvironmentIcon client label={text('客户端', 'Client')} />{text('客户端', 'Client')}</>} pending={text('客户端未检测', 'Client not tested')} summary={coverageText('claude')} maximum={scores.coverage.claude.maximum} /></div></div>
          </section>
          <div className="workspace-columns">
            <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('出口环境', 'Exit environment')}</h2><button className="repair-button repair-button--quiet" type="button" disabled={busy} aria-busy={checking} onClick={props.onRefresh}>{checking ? text('检测中…', 'Checking…') : text('刷新', 'Refresh')}</button></div><dl className="workspace-fields">
              <div><dt>{text('出口 IP', 'Exit IP')}</dt><dd>{report?.target?.ip ?? geo?.ip ?? text('未识别', 'Unknown')}</dd></div>
              <div><dt>{text('地区', 'Region')}</dt><dd>{report?.target?.countryName ?? geo?.countryName ?? '—'}{(report?.target?.city ?? geo?.city) ? ` · ${report?.target?.city ?? geo?.city}` : ''}</dd></div>
              <div><dt>{text('运营商', 'Network')}</dt><dd>{geo?.org ?? geo?.asn ?? '—'}</dd></div>
              <div><dt>{text('网络类型', 'Network type')}</dt><dd title={networkType.detail}>{networkType.label}<span className="sr-only"> · {networkType.detail}</span></dd></div>
            </dl></section>
            <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('保护配置', 'Protection settings')}</h2></div><dl className="workspace-fields">
              <div><dt>{text('目标时区', 'Timezone')}</dt><dd>{report?.target?.timezone ?? target?.timezone ?? '—'}</dd></div>
              <div><dt>{text('语言 / 区域', 'Language / locale')}</dt><dd>{report?.target?.language ?? target?.language ?? '—'}</dd></div>
              <div><dt>{text('实时检测', 'Monitoring')}</dt><dd className="workspace-monitor-controls"><label className="workspace-monitor"><input type="checkbox" role="switch" aria-label={text('实时检测', 'Monitoring')} checked={connected && Boolean(report?.monitoring)} disabled={busy || !connected || !report} onChange={(event) => props.onMonitor(event.target.checked, intervalMs)} /><span className="sr-only">{text('实时检测', 'Monitoring')}</span></label><select className="workspace-interval" aria-label={text('自动检测间隔', 'Automatic test interval')} value={intervalMs} disabled={busy || !connected || !report} onChange={(event) => props.onMonitor(Boolean(report?.monitoring), Number(event.target.value))}>{[[30000, text('每30秒', 'Every 30 seconds')], [60000, text('每分钟', 'Every minute')], [300000, text('每5分钟', 'Every 5 minutes')], [600000, text('每10分钟', 'Every 10 minutes')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></dd></div>
              <DesktopSettingsFields locale={locale} protectionEnabled={protectionEnabled} />
              <div className="workspace-browser-link"><dt>{text('浏览器模拟保护', 'Browser cloak')}</dt><dd>
                <BrowserCloakStatus report={props.browserCloak ?? null} locale={locale} />
                <button type="button" className="repair-button" disabled={busy || props.linkingBrowser} onClick={() => props.onLinkBrowser?.()}>{props.linkingBrowser ? text('接入中…', 'Linking…') : text('接入并验证浏览器', 'Link & verify browser')}</button>
                <button type="button" className="repair-button repair-button--quiet" disabled={busy} onClick={() => props.onOpenBrowserPicker?.()}>{text('选择浏览器', 'Choose browser')}</button>
              </dd></div>
            </dl></section>
          </div>
          <section className="workspace-panel"><div className="workspace-section-heading"><h2>{text('异常项目', 'Flagged items')}<span className="workspace-heading-count">{actionable.length}</span></h2><button type="button" className="repair-button repair-button--quiet" onClick={() => { props.onFilter('issues'); props.onSearch(''); setTab('tests'); }}>{text('查看全部', 'View all')} →</button></div>{actionable.length ? <div className="workspace-issue-list">{actionable.slice(0, 6).map((signal) => <button type="button" key={signal.id} onClick={() => props.onSelect(signal.id)}><span className="workspace-issue-name">{signal.label}{issueSides(signal)}</span><span>{failed(signal) ? text("检测失败", "Failed") : text('未通过', 'Not passed')} →</span></button>)}</div> : <p>{measured ? text('可保护项暂无异常', 'No protectable items flagged') : text('尚未检测，请启动保护或刷新环境。', 'Start protection or refresh to run tests.')}</p>}
            {beyondProtection.length > 0 && <details className="workspace-details" data-beyond-protection={beyondProtection.length}>
              <summary>{text(`保护范围外 · ${beyondProtection.length}`, `Outside protection · ${beyondProtection.length}`)}</summary>
              <p className="workspace-meta">{text('这些项不是声明面能改的：字体/Emoji 是系统事实，出口与可达性取决于节点和网络。', 'These are not declaration-layer items: fonts and emoji are system facts; exit and reachability depend on the node and network.')}</p>
              <ul>{beyondProtection.map((signal) => <li key={signal.id}><button type="button" className="workspace-issue-name" onClick={() => props.onSelect(signal.id)}>{signal.label}</button><span className="workspace-meta">{requirementLabel(zh, signalRequirement(signal.id))}</span></li>)}</ul>
            </details>}</section>
          {Boolean(report?.issues.length) && <details className="workspace-panel workspace-details"><summary>{text('执行详情', 'Operation details')} · {report!.issues.length}</summary><ul>{report!.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
        </div>
        <div id="panel-network" role="tabpanel" aria-labelledby="tab-network" tabIndex={0} hidden={tab !== 'network'}>
          <NetCorePanel locale={locale} report={props.netCore} busy={Boolean(props.netCoreBusy) || busy} error={props.netCoreError} onRefresh={props.onNetCoreRefresh} onRestart={props.onNetCoreRestart} onSelectNode={props.onNetCoreSelect} onAddConfig={props.onNetCoreAddConfig} onEditConfig={props.onNetCoreEditConfig} onOpenNetworkConfig={props.onNetCoreOpenNetworkConfig} onRefreshSubscription={props.onNetCoreRefreshSubscription} onMeasure={props.onNetCoreMeasure} onModeChange={props.onNetCoreModeChange} measuring={props.netCoreMeasuring} delays={props.netCoreDelays} exits={props.netCoreExits ?? {}} probingExits={props.netCoreExiting} onProbeExits={props.onNetCoreProbeExits} exitHistory={props.netCoreExitHistory ?? null} networkState={props.netCoreNetwork ?? null} />
        </div>
        <div id="panel-tests" role="tabpanel" aria-labelledby="tab-tests" tabIndex={0} hidden={tab !== 'tests'}>
          <div className="workspace-toolbar"><div className="workspace-filters" role="group" aria-label={text('检测状态筛选', 'Filter tests')}>{[['all',text('全部','All')],['issues',text('异常','Issues')],['pending',text('待处理','Pending')],['passed',text('通过','Passed')]].map(([id,label]) => <button key={id} className="repair-button repair-button--quiet" type="button" aria-pressed={props.filter === id} onClick={() => props.onFilter(id)}>{label}</button>)}</div><input type="search" aria-label={text('搜索检测项','Search tests')} placeholder={text('搜索检测项','Search tests')} value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></div>
          <div className="workspace-test-summary"><p className="workspace-meta">{text(`已测 ${measured} / ${signals.length} · 可保护 ${actionable.length} · 保护范围外 ${beyondProtection.length} · 未判定 ${signals.length - measured}`, `Measured ${measured} / ${signals.length} · Protectable ${actionable.length} · Outside ${beyondProtection.length} · Unresolved ${signals.length - measured}`)}</p><div className="workspace-legend" aria-label={text('检测状态图例', 'Test status legend')}><span data-kind="measured">{text('原生通过', 'Native pass')}</span><span data-kind="simulated">{text('保护后通过', 'Protected pass')}</span><span data-kind="flagged">{text('异常', 'Flagged')}</span><span data-kind="pending">{text('未判定', 'Unresolved')}</span><span className="workspace-source-legend" data-environment="browser"><EnvironmentIcon client={false} label={text('浏览器', 'Browser')} />{text('浏览器', 'Browser')}</span><span className="workspace-source-legend" data-environment="client"><EnvironmentIcon client label={text('客户端', 'Client')} />{text('客户端', 'Client')}</span></div></div>
          {cards}
        </div>
        <div id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" tabIndex={0} hidden={tab !== 'compare'}>
          <section className="workspace-panel"><div className="workspace-section-heading workspace-comparison-heading"><div><h2>{text('保护前后对比', 'Before and after protection')}</h2><p>{time(baseline?.at)}</p></div><div className="workspace-comparison-summary"><div className="workspace-comparison-score"><span>{text('验证得分', 'Verification score')}</span><strong>{baseline ? verificationScores(baseline.browser, baseline.claude).combined ?? '—' : '—'}</strong><span aria-label={text('变为', 'to')}>→</span><strong>{total ?? '—'}</strong></div><label className="workspace-monitor"><input type="checkbox" role="switch" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />{text('只看差异与未通过项','Only differences and unresolved items')}</label></div></div>
            {!baseline ? <p className="workspace-empty">{text('启动保护后查看前后对比。','Start protection to capture a baseline and compare results.')}</p> : <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={text('保护前后检测数据', 'Before and after test data')}><table className="workspace-comparison"><colgroup><col className="workspace-comparison__name" /><col /><col /><col className="workspace-comparison__state" /></colgroup><thead><tr><th scope="col">{text('检测项目','Test item')}</th><th scope="col">{text('启动前','Before activation')}<small>{text('浏览器 / 客户端','Browser / client')}</small></th><th scope="col">{text('当前实测','Current measurements')}<small>{text('浏览器 / 客户端','Browser / client')}</small></th><th scope="col">{text('状态','Status')}</th></tr></thead><tbody>{rows.map(({ signal, beforeBrowser, beforeClaude, afterBrowser, afterClaude, verified, status }) => <tr key={signal.id} data-result={status === 'error' || points(signal) > 0 ? 'flagged' : verified ? 'passed' : 'pending'}><th scope="row"><button type="button" className="signal-card__action" aria-haspopup="dialog" onClick={() => props.onSelect(signal.id)}>{signal.label}</button></th><td>{pair(signal.id, beforeBrowser, beforeClaude)}</td><td>{pair(signal.id, afterBrowser, afterClaude)}</td><td><span className="workspace-result">{status === 'not_applicable' ? text('不适用','N/A') : status === 'error' ? text('检测失败','Failed') : verificationItem(signal.id, afterBrowser, afterClaude) === 'failed' ? text('未通过','Not passed') : !verified ? text('待确认','Unverified') : text('通过','Passed')}</span></td></tr>)}</tbody></table>{!rows.length && <p className="workspace-empty">{text('当前没有差异或未通过项。','No differences or unresolved items.')}</p>}</div>}
          </section>
          <details className="workspace-panel workspace-details"><summary>{text('检测与恢复记录','Test and restoration history')}{report?.history.length ? ` · ${report.history.length}` : ''}</summary>{report?.history.length ? <ol className="workspace-history">{report.history.map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{time(event.at)}</time><span>{event.message}</span></li>)}</ol> : <p>{text('暂无记录','No events yet')}</p>}</details>
        </div>
      </div>
    </div>
  </section>;
}
