"use client";

import { useState, useSyncExternalStore } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import type { ConnectionRecord, NetCoreReport } from '@/detection/gateway-check';
import { netCoreView, trafficFlowSamples, activeFlowConnections } from '@/detection/net-core-view.mjs';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';

function subscribeMotion(listener: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', listener);
  document.addEventListener('visibilitychange', listener);
  return () => { media.removeEventListener('change', listener); document.removeEventListener('visibilitychange', listener); };
}
const canAnimate = () => !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const subscribeFreshness = (listener: () => void) => {
  const timer = window.setInterval(listener, 1000);
  return () => window.clearInterval(timer);
};
// 光丝在近处展开、远处收束，避免等距描边形成实心管道。
const depths = [-1, -.64, -.3, 0, .3, .64, 1];
const flowPaths = (depth: number) => ({
  direct: `M65 104 C148 ${104 + depth * 78} 260 ${48 + depth * 32} 420 48`,
  gateway: `M65 104 C112 ${104 + depth * 72} 190 ${128 + depth * 38} 250 128`,
  proxy: `M250 128 C302 ${128 + depth * 44} 370 ${148 + depth * 58} 420 148`,
});
const particlePath = (route: 'direct' | 'proxy', index: number) => {
  const paths = flowPaths(depths[index % depths.length]);
  return route === 'direct' ? paths.direct : `${paths.gateway} ${paths.proxy.replace('M250 128', '')}`;
};
const motionSeconds = 6;
// 名字只在粒子离开本机后的 2 秒内出现；按轮次错开，连接多时也不会在起点同时挤满名字。
const labelSeconds = 2;
const labelLead = 0.35; // 等光点先走出本机图标，再从右侧显示名字
const labelsPerLoop = 3;

/** Each path uses its own current connection samples; mode alone never creates traffic. */
export function TrafficFlow({ report, locale, onDetails, onConnection, onRoute }: { report: NetCoreReport | null; locale: LocaleCode; onDetails: () => void; onConnection?: (record: ConnectionRecord) => void; onRoute?: (route: 'proxied' | 'direct' | 'blocked') => void }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const view = netCoreView(report, { locale });
  // 只冻结当前光点，连接被刷新移除时也不会留下整张 SVG 的暂停状态。
  const [revealed, setRevealed] = useState<{ id: string; transform: string } | null>(null);
  const reveal = (id: string, element: SVGGElement) => {
    const root = element.ownerSVGElement?.getScreenCTM();
    const current = element.getScreenCTM();
    if (!root || !current) return;
    const position = root.inverse().multiply(current);
    setRevealed({ id, transform: `translate(${position.e} ${position.f})` });
  };
  const release = (id: string, element: SVGGElement) => {
    if (!element.matches(':hover') && !element.matches(':focus-visible')) setRevealed(current => current?.id === id ? null : current);
  };
  const motion = useSyncExternalStore(subscribeMotion, canAnimate, () => false);
  const isFresh = () => {
    const age = Date.now() - Date.parse(report?.routing?.sampledAt ?? '');
    return age >= -5000 && age <= 45000;
  };
  const fresh = useSyncExternalStore(subscribeFreshness, isFresh, () => false);
  const isActiveFresh = () => { const age = Date.now() - Date.parse(report?.connectionLog?.sampledAt ?? ''); return age >= -5000 && age <= 10000; };
  const activeFresh = useSyncExternalStore(subscribeFreshness, isActiveFresh, () => false);
  const live = activeFlowConnections(activeFresh ? report : null);
  const violation = report?.state === 'running' && view.violationCount > 0;
  const samples = trafficFlowSamples(fresh ? report : null);
  const proxied = (samples.proxied ?? 0) > 0;
  const direct = (samples.direct ?? 0) > 0;
  const countLabel = (count: number | null) => count === null ? text('待采样', 'No sample') : text(`${count} 条`, `${count} conn.`);
  const proxyHint = report?.mode === 'global'
    ? text('全局：国内外公网连接均经代理，内网豁免除外。', 'Global: domestic and international public traffic uses the proxy, except bypasses.')
    : text('经代理的连接，包含 Claude；具体节点与代理链可在传输记录中查看。', 'Proxied connections, including Claude; view transfer details for the actual node and chain.');
  const directHint = report?.mode === 'global'
    ? text('全局模式仍允许内网豁免；模式切换前已建立的连接也可能继续直连。', 'Global mode retains local bypasses; connections established before switching may also remain direct.')
    : text('内核观察到的直连连接，不代表全部国内流量。', 'Direct connections observed by the kernel; these do not represent all domestic traffic.');
  const nodes: { id: string; icon: WorkspaceIconName; label: string; short: string; observed?: boolean }[] = [
    { id: 'origin', icon: 'monitor', label: text('本机', 'This device'), short: text('本机', 'Device') },
    { id: 'direct', icon: 'home', label: `${directHint} ${countLabel(samples.direct)}`, short: `${text('直连', 'Direct')} · ${countLabel(samples.direct)}`, observed: direct },
    { id: 'gateway', icon: 'router', label: text('代理网关 · 点击查看已拦截连接', 'Proxy gateway · select to view blocked connections'), short: text('代理网关', 'Gateway') },
    { id: 'proxy', icon: 'globe', label: `${proxyHint} ${countLabel(samples.proxied)}`, short: `${text('代理出口', 'Proxy exit')} · ${countLabel(samples.proxied)}`, observed: proxied },
  ];
  const observed = { direct, gateway: proxied, proxy: proxied };
  const routeFor = (record: ConnectionRecord): 'direct' | 'proxy' | null => record.route === 'direct' ? 'direct' : record.route === 'proxied' ? 'proxy' : null;
  const labelLoops = Math.max(1, Math.ceil(live.records.length / labelsPerLoop));
  const labelCycle = motionSeconds * labelLoops;
  // keyTimes 以整轮为分母：名字在光点离开本机后出现，整 2 秒时完全隐藏。
  const labelAt = (seconds: number) => (seconds / labelCycle).toFixed(4);
  const labelKeyTimes = ['0', labelAt(labelLead), labelAt(labelLead + 0.15), labelAt(labelLead + labelSeconds - 0.3), labelAt(labelLead + labelSeconds), '1'].join(';');
  const labelBegin = (index: number) => {
    const delay = ((index * 0.73) % motionSeconds) + motionSeconds * (index % labelLoops);
    return `${delay ? '-' : ''}${delay.toFixed(2)}s`;
  };
  const stationaryPoint = (route: 'direct' | 'proxy' | null, index: number) => {
    if (!route) return `translate(${65 + index % 3 * 6} ${104 + index % 5 * 3})`;
    const fraction = (index + .5) / Math.max(1, live.records.length);
    const t = route === 'proxy' ? (fraction < .5 ? fraction * 2 : (fraction - .5) * 2) : fraction;
    const points = route === 'direct' ? [[65,104],[150,104],[240,48],[420,48]] : fraction < .5 ? [[65,104],[145,104],[185,128],[250,128]] : [[250,128],[320,128],[350,148],[420,148]];
    const at = (axis: number) => (1-t)**3 * points[0][axis] + 3*(1-t)**2*t * points[1][axis] + 3*(1-t)*t*t * points[2][axis] + t**3 * points[3][axis];
    return `translate(${at(0)} ${at(1)})`;
  };
  const ambient = motion && report?.state === 'running';
  return <div className="workspace-flow" data-tone={violation ? 'danger' : proxied || direct ? 'ok' : 'muted'} role="group" aria-label={text('网络路径：代理出口与直连；代理出口包含 Claude；仅覆盖内核当前连接采样', 'Routing: proxy exit and direct; proxy includes Claude; current kernel connection samples only')}>
    <div className="workspace-flow__diagram">
    <svg className="workspace-flow__lines" viewBox="0 0 500 208" preserveAspectRatio="none" role="group" aria-label={text('活动连接，点击查看传输详情', 'Active connections; select to view transfer details')}>
      {(['direct', 'gateway', 'proxy'] as const).map(id => <g key={id} className={`workspace-flow__path workspace-flow__path--${id}`} data-verified={observed[id]}>
        {depths.map((depth, index) => <g key={index} opacity={1 - Math.abs(depth) * .65}>
          <path d={flowPaths(depth)[id]} />
          {ambient && <path className="workspace-flow__filament" d={flowPaths(depth)[id]} strokeDasharray="2 85" pathLength={174}>
            <animate attributeName="stroke-dashoffset" values="174;0" dur={`${4 + index * .45}s`} begin={`${-index * .8}s`} repeatCount="indefinite" />
          </path>}
        </g>)}
      </g>)}
      {ambient && (['direct', 'proxy'] as const).flatMap(route => Array.from({ length: 8 }, (_, i) => <g key={`${route}-${i}`} className={`workspace-flow__photon workspace-flow__photon--${route}`} aria-hidden="true">
        <ellipse cx="-3" rx="5" ry=".65" opacity=".5" /><circle r="3.6" opacity=".14" /><circle r="1.2" />
        <animateMotion dur={`${4 + i * .47}s`} begin={`${-i * 1.3}s`} rotate="auto" repeatCount="indefinite" path={particlePath(route, i)} />
        <animate attributeName="opacity" values="0;.8;.8;0" keyTimes="0;.12;.86;1" dur={`${4 + i * .47}s`} begin={`${-i * 1.3}s`} repeatCount="indefinite" />
      </g>))}
      {live.records.map((record, i) => {
        const route = routeFor(record);
        const name = record.host || record.ip || text('未知主机', 'Unknown host');
        const label = name.length > 24 ? name.slice(0, 21) + '…' : name;
        const info = `${record.isClaude ? 'Claude · ' : ''}${name} · ${record.route === 'proxied' ? text('代理出口', 'Proxy exit') : record.route === 'direct' ? text('直连', 'Direct') : record.route === 'blocked' ? text('已拦截', 'Blocked') : text('路径未知', 'Unknown route')}`;
        const open = () => onConnection ? onConnection(record) : onDetails();
        const frozen = revealed?.id === record.id;
        return <g key={record.id} className={`workspace-flow__connection workspace-flow__connection--${route ?? 'unknown'}`} data-claude={record.isClaude === true} data-revealed={frozen} role="button" tabIndex={0} aria-label={`${record.isClaude ? 'Claude · ' : ''}${name} · ${text('查看连接详情', 'View connection details')}`} onPointerEnter={event => reveal(record.id, event.currentTarget)} onPointerLeave={event => release(record.id, event.currentTarget)} onFocus={event => reveal(record.id, event.currentTarget)} onBlur={event => release(record.id, event.currentTarget)} onClick={open} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }} transform={frozen ? revealed.transform : motion && route ? undefined : stationaryPoint(route, i)}>
          {motion && route && !frozen && <animateMotion dur={`${motionSeconds}s`} begin={`${-i * .73}s`} repeatCount="indefinite" path={particlePath(route, i)} />}
          <title>{info}</title><circle className="workspace-flow__hit" r="7" /><circle r="1.5" /><text textAnchor="start" x={12} y={i % 2 ? 12 : -6}>{motion && route && !frozen && <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes={labelKeyTimes} dur={`${labelCycle}s`} begin={labelBegin(i)} repeatCount="indefinite" />}{label}</text>
        </g>;
      })}

    </svg>
    {nodes.map(node => <button key={node.id} type="button" className={`workspace-flow__node workspace-flow__node--${node.id}`} data-observed={node.observed} aria-label={node.label} aria-haspopup={node.id !== 'origin' ? 'dialog' : undefined} onClick={() => { if (onRoute && node.id !== 'origin') onRoute(node.id === 'proxy' ? 'proxied' : node.id === 'gateway' ? 'blocked' : 'direct'); else onDetails(); }}>
      <span className="workspace-flow__symbol"><WorkspaceIcon name={node.icon} />{node.id === 'proxy' && <span className="workspace-flow__mascot" aria-hidden="true"><span /></span>}</span>
      <span className="workspace-flow__label" aria-hidden="true">{node.short}</span>
      <span className="workspace-flow__tooltip" role="tooltip">{node.label}</span>
    </button>)}
    {violation && <button type="button" className="workspace-flow__warning" onClick={onDetails} aria-label={view.conclusion.title} title={view.conclusion.title}>!</button>}
    </div>
    <div className="workspace-flow__footer">
    <span className="workspace-flow__caption">{text('网络连接流向 · 悬停查看信息，点击打开详情', 'Network connection flow · hover for info, select for details')}{report?.connectionLog?.scope === 'claude' && text(' · 仅记录 Claude', ' · Claude-only log')}{(samples.blocked ?? 0) > 0 && text(` · 阻断 ${samples.blocked} 条`, ` · ${samples.blocked} blocked`)}{(samples.unknown ?? 0) > 0 && text(` · 路径未知 ${samples.unknown} 条`, ` · ${samples.unknown} unknown`)}</span>
    </div>
  </div>;
}
