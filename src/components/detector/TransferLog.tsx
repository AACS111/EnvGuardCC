"use client";

import { useEffect, useId, useRef, useState, useImperativeHandle, useCallback } from 'react';
import type { Ref } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import type { ConnectionRecord, ConnectionsResult, ConnectionRouteFilter, ConnectionStateFilter } from '@/detection/gateway-check';
import { readConnections, clearConnections, exportConnections } from '@/detection/gateway-check';
import { isDialogBackdropEvent } from './RepairDialog';

const byteLabel = (value: number) => {
  if (value < 1024) return `${value} B`;
  const scale = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** scale).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][scale]}`;
};
const address = (record: ConnectionRecord) => `${record.ip ? (record.ip.includes(':') ? `[${record.ip}]` : record.ip) : '—'}${record.port ? `:${record.port}` : ''}`;
const timeLabel = (at: string | null, locale: LocaleCode) => at ? new Date(at).toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', { hour12: false }) : '—';
const privacy = (zh: boolean) => zh ? '数据只存放在本机，不会上传' : 'Data is stored only on this device and is never uploaded';
const statusLabel = (record: ConnectionRecord, zh: boolean) => record.endedAt ? (zh ? '已结束' : 'Ended') : (zh ? '活动中' : 'Active');

export function TransferLogCard({ locale, data, onOpen }: { locale: LocaleCode; data: ConnectionsResult | null; onOpen: (record?: ConnectionRecord) => void }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  return <section className="netcore-block transfer-log-card" aria-label={text('传输记录', 'Transfer log')}>
    <div className="netcore-block__head"><h3>{text('传输记录', 'Transfer log')}</h3><button type="button" className="workspace-text-link" aria-haspopup="dialog" onClick={() => onOpen()}>{text('查看全部', 'View all')} →</button></div>
    <p className="netcore-detail"><strong>{privacy(zh)}</strong></p>
    {data?.scope === 'claude' && <p className="workspace-meta">{text('记录范围：仅 Claude', 'Recording scope: Claude only')}</p>}
    <button type="button" className="transfer-log-card__counts" aria-haspopup="dialog" onClick={() => onOpen()}>
      {text(`活动 ${data?.available === false && data.stats.active > 0 ? '—' : data?.stats.active ?? 0} 条 · 48 小时 ${data?.stats.total ?? 0} 条`, `${data?.available === false && data.stats.active > 0 ? '—' : data?.stats.active ?? 0} active · ${data?.stats.total ?? 0} in 48 hours`)}
    </button>
    {!data?.available && <p className="workspace-meta">{text('采样已暂停或内核尚无连接；已有记录仍保留。', 'Sampling is paused or no kernel connections are available; saved records remain.')}</p>}
    {data?.storageError && <p className="netcore-alert" role="status">{text('本机记录暂时无法保存，请检查磁盘空间或权限。', 'Local records cannot be saved. Check disk space or permissions.')}</p>}
    <p className="workspace-meta">{text('最近 3 条', 'Latest 3')}</p>
    {(data?.recent.length ?? 0) > 0 ? <ul className="transfer-log-card__recent">
      {data!.recent.map(record => <li key={record.id}><button type="button" onClick={() => onOpen(record)} aria-haspopup="dialog"><span>{record.host || record.ip || '—'}</span><span>{statusLabel(record, zh)} · ↓ {byteLabel(record.download)}</span></button></li>)}
    </ul> : <p className="netcore-detail">{text('暂无传输记录', 'No transfer records yet')}</p>}
  </section>;
}

export function TransferRecordDetails({ record, locale, at = null }: { record: ConnectionRecord; locale: LocaleCode; at?: string | null }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const route = record.viaExit === true ? text('已走代理出口', 'Used a proxy exit') : record.route === 'blocked' ? text('已阻断', 'Blocked') : record.viaExit === false ? text('直连', 'Direct') : text('未知', 'Unknown');
  const state = at ? Date.parse(record.startedAt) > Date.parse(at) ? text('当时尚未开始', 'Not started at replay time') : record.endedAt && Date.parse(record.endedAt) <= Date.parse(at) ? text('当时已结束', 'Ended before replay time') : text('当时活动', 'Active at replay time') : statusLabel(record, zh);
  const fields = [
    ['ID', record.id], [text('主机', 'Host'), record.host || '—'], [text('IP:端口', 'IP:port'), address(record)],
    [text('状态', 'Status'), state], [text('代理链', 'Proxy chain'), record.chains.join(' → ') || '—'],
    [text('命中规则', 'Matched rule'), [record.rule, record.rulePayload].filter(Boolean).join(' · ') || '—'],
    [text('上行字节', 'Uploaded bytes'), `${record.upload} B`], [text('下行字节', 'Downloaded bytes'), `${record.download} B`],
    [text('开始时间', 'Started'), timeLabel(record.startedAt, locale)], [text('结束时间', 'Ended'), timeLabel(record.endedAt, locale)],
    [text('是否 Claude', 'Claude connection'), record.isClaude ? text('是', 'Yes') : text('否', 'No')],
    [text('是否走出口', 'Proxy exit'), route],
    ...(record.kind === 'request' ? [['Method', record.method ?? '—'], ['Endpoint', record.endpoint ?? '—'], [text('HTTP 状态', 'HTTP status'), String(record.status ?? '—')], [text('请求耗时', 'Request duration'), record.elapsedMs == null ? '—' : `${record.elapsedMs} ms`], [text('请求结果', 'Request result'), record.error ?? (record.endedAt ? text('已收到响应', 'Response received') : text('请求进行中', 'Request in progress'))]] : []),
  ];
  return <section className="transfer-log-detail" aria-label={text('连接详情', 'Connection details')}>
    <h3>{text('连接详情', 'Connection details')}</h3><p className="netcore-detail"><strong>{privacy(zh)}</strong></p>
    <dl className="workspace-fields">{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    {record.kind === 'request' && <p className="workspace-meta">{text('来自应用 HTTP 网关；未关联内核代理链时，出口显示未知。TUN 中的其他 HTTPS 不解密。', 'Captured at the app HTTP gateway. Exit stays unknown without a kernel chain; other HTTPS in TUN is not decrypted.')}</p>}
    {at && <p className="workspace-meta">{text('回放按起止时间还原活动状态；字节为最后采样的累计值。', 'Replay reconstructs activity from start/end times; bytes are the last sampled totals.')}</p>}
    <p className="workspace-meta">{text('结束时间由采样估算；不记录正文、URL 查询参数或进程路径。', 'End times are estimated from samples. Bodies, URL query parameters and process paths are not recorded.')}</p>
  </section>;
}

type DialogProps = {
  locale: LocaleCode; data: ConnectionsResult | null; selected: ConnectionRecord | null;
  host: string; claude: boolean; route?: ConnectionRouteFilter; recordState?: ConnectionStateFilter; offset: number; clearing: boolean; error: string;
  onHost: (value: string) => void; onClaude: (value: boolean) => void; onRoute?: (value: ConnectionRouteFilter) => void; onState?: (value: ConnectionStateFilter) => void;
  kind?: 'all' | 'connection' | 'request'; at?: string | null; replayBase?: number; replayPosition?: number; playing?: boolean; speed?: number; exporting?: boolean;
  onKind?: (kind: 'all' | 'connection' | 'request') => void; onReplay?: () => void; onSeek?: (seconds: number) => void; onPlay?: () => void; onSpeed?: (speed: number) => void; onExport?: (format: 'json' | 'csv') => void;
  onPage: (offset: number) => void; onSelect: (record: ConnectionRecord | null) => void; onClear: () => void; onClose: () => void;
};
export function TransferLogDialog(props: DialogProps) {
  const { locale, data, selected, host, claude, route = 'all', recordState = 'all', offset, clearing, error, onHost, onClaude, onRoute, onState, onPage, onSelect, onClear, onClose, kind = 'all', at = null, replayBase = 0, replayPosition = 172800, playing = false, speed = 60, exporting = false, onKind, onReplay, onSeek, onPlay, onSpeed, onExport } = props;
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useRef(false);
  const title = useId();
  const heading = route === 'proxied' ? text('代理出口连接', 'Proxy exit connections') : route === 'direct' ? text('直连连接', 'Direct connections') : route === 'blocked' ? text('已拦截连接', 'Blocked connections') : text('传输记录', 'Transfer log');
  const replayReady = !at || data?.at === at;
  const rows = replayReady ? data?.items ?? [] : [];
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => { if (element.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="repair-dialog transfer-log-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdrop.current = isDialogBackdropEvent(event); }}
    onClick={event => { if (backdrop.current && isDialogBackdropEvent(event)) onClose(); backdrop.current = false; }}>
    <header className="repair-dialog__header"><div><h2 id={title}>{heading}</h2><p><strong>{privacy(zh)}</strong></p></div><button type="button" className="repair-button repair-button--quiet" aria-label={text('关闭', 'Close')} onClick={onClose}>×</button></header>
    <div className="repair-dialog__body">
      <p className="netcore-detail">{text('保留最近 48 小时，最多 2 万条 / 5 MB。仅记录采样时经过内核的连接，短于采样间隔的连接可能未被捕获。', 'Kept for 48 hours, up to 20,000 records / 5 MB. Only connections observed by the kernel are recorded; connections shorter than the sample interval may be missed.')}</p>
      <div className="transfer-log-filters">
        <label>{text('主机 / IP', 'Host / IP')}<input value={host} maxLength={253} onChange={event => onHost(event.target.value)} placeholder={text('筛选主机', 'Filter host')} /></label>
        <label className="transfer-log-check"><input type="checkbox" checked={claude} onChange={event => onClaude(event.target.checked)} />{text('仅 Claude', 'Claude only')}</label>
        <label>{text('记录类型', 'Record type')}<select value={kind} onChange={event => onKind?.(event.target.value as 'all' | 'connection' | 'request')}><option value="all">{text('全部', 'All')}</option><option value="connection">{text('内核连接', 'Kernel connections')}</option><option value="request">{text('Claude 请求', 'Claude requests')}</option></select></label>
        <label>{text('连接路径', 'Route')}<select value={route} onChange={event => onRoute?.(event.target.value as ConnectionRouteFilter)}><option value="all">{text('全部', 'All')}</option><option value="proxied">{text('代理出口', 'Proxy exit')}</option><option value="direct">{text('直连', 'Direct')}</option><option value="blocked">{text('已阻断', 'Blocked')}</option><option value="unknown">{text('未知', 'Unknown')}</option></select></label>
        <label>{text('连接状态', 'Connection state')}<select value={recordState} disabled={Boolean(at)} onChange={event => onState?.(event.target.value as ConnectionStateFilter)}><option value="all">{text('全部记录', 'All records')}</option><option value="active">{text('活动连接', 'Active connections')}</option><option value="ended">{text('已结束', 'Ended')}</option></select></label>
      </div>
      <div className="transfer-log-tools"><button type="button" className="repair-button repair-button--quiet" onClick={onReplay} aria-pressed={Boolean(at)}>{at ? text('返回实时', 'Return to live') : text('48 小时回放', '48-hour replay')}</button><button type="button" className="repair-button repair-button--quiet" disabled={exporting || !data?.total} onClick={() => onExport?.('json')}>{text('导出 JSON', 'Export JSON')}</button><button type="button" className="repair-button repair-button--quiet" disabled={exporting || !data?.total} onClick={() => onExport?.('csv')}>{text('导出 CSV', 'Export CSV')}</button></div>
      {kind === 'request' && <p className="workspace-meta">{text('仅记录经应用 HTTP 网关转发的请求；TUN 内加密 HTTPS 仅有连接记录。', 'Only requests forwarded by the app HTTP gateway are captured; encrypted HTTPS in TUN has connection records only.')}</p>}
      {at && <section className="transfer-log-replay" aria-label={text('传输记录回放', 'Transfer log replay')}><div><strong>{text('回放时刻', 'Replay time')} · {timeLabel(at, locale)}</strong><button type="button" className="repair-button repair-button--quiet" onClick={onPlay}>{playing ? text('暂停', 'Pause') : text('播放', 'Play')}</button><label>{text('速度', 'Speed')}<select value={speed} onChange={event => onSpeed?.(Number(event.target.value))}><option value={1}>1×</option><option value={60}>60×</option><option value={600}>600×</option></select></label></div><input type="range" min={0} max={172800} step={1} value={replayPosition} onChange={event => onSeek?.(Number(event.target.value))} aria-label={text('48 小时回放时间轴', '48-hour replay timeline')} /><div className="workspace-meta"><span>{timeLabel(new Date(replayBase - 172800000).toISOString(), locale)}</span><span>{timeLabel(new Date(replayBase).toISOString(), locale)}</span></div><p className="workspace-meta">{text('按起止时间还原活动连接；字节为最终或最近累计值，不是所选时刻的流量。', 'Activity is reconstructed from start/end times. Bytes are final or latest totals, not traffic at the selected time.')}</p><p role="status">{data?.at === at ? text(`当时活动 ${data.total} 条`, `${data.total} active at this time`) : text('正在读取回放…', 'Loading replay…')}</p></section>}
      {!data?.available && !at && <p className="workspace-meta" role="status">{text('当前未采样，已有记录仍可查看。', 'Sampling is paused. Existing records remain available.')}</p>}
      {data?.storageError && <p className="netcore-alert" role="status">{text('本机记录保存失败，请检查磁盘空间或权限。', 'Could not save local records. Check disk space or permissions.')}</p>}
      {error && <p className="netcore-alert" role="alert">{error}</p>}
      <div className="transfer-log-content" data-detail={Boolean(selected)}><div>
        <ul className="transfer-log-list">{rows.map(record => <li key={record.id}><button type="button" aria-expanded={selected?.id === record.id} onClick={() => onSelect(selected?.id === record.id ? null : record)}>
          <span><strong>{record.host || record.ip || '—'}</strong><small>{address(record)} · {record.isClaude ? 'Claude · ' : ''}{at ? text('当时活动', 'Active then') : statusLabel(record, zh)}{record.kind === 'request' ? ` · ${record.method} ${record.endpoint} · ${record.status ?? '—'}` : ''}</small></span>
          <span className="transfer-log-list__bytes">↑ {byteLabel(record.upload)}<br />↓ {byteLabel(record.download)}</span>
        </button></li>)}</ul>
        {replayReady && !rows.length && <p className="netcore-detail transfer-log-empty">{text('暂无匹配的传输记录', 'No matching transfer records')}</p>}
        <nav className="transfer-log-pagination" aria-label={text('传输记录分页', 'Transfer log pages')}>
          <button type="button" className="repair-button repair-button--quiet" disabled={offset === 0 || clearing} onClick={() => onPage(Math.max(0, offset - 50))}>{text('上一页', 'Previous')}</button>
          <span>{text(`共 ${data?.total ?? 0} 条`, `${data?.total ?? 0} records`)} · {Math.floor(offset / 50) + 1}</span>
          <button type="button" className="repair-button repair-button--quiet" disabled={offset + 50 >= (data?.total ?? 0) || clearing} onClick={() => onPage(offset + 50)}>{text('下一页', 'Next')}</button>
        </nav>
      </div>{selected && <TransferRecordDetails record={selected} locale={locale} at={at} />}</div>
    </div>
    <footer className="repair-dialog__footer"><span className="workspace-meta">{text('清空后删除本机记录文件，之后的新采样会重新开始记录。', 'Clearing deletes the local record file. Future samples start a new log.')}</span><button type="button" className="repair-button repair-button--quiet" disabled={clearing || !data?.stats.total} onClick={onClear}>{clearing ? text('清空中…', 'Clearing…') : text('清空记录', 'Clear records')}</button></footer>
  </dialog>;
}

export type TransferLogHandle = { open: (record?: ConnectionRecord) => void; openRoute: (route: 'proxied' | 'direct' | 'blocked') => void };

export function TransferLog({ locale, visible = true, controllerRef }: { locale: LocaleCode; visible?: boolean; controllerRef?: Ref<TransferLogHandle> }) {
  const [data, setData] = useState<ConnectionsResult | null>(null);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [claude, setClaude] = useState(false);
  const [route, setRoute] = useState<ConnectionRouteFilter>('all');
  const [recordState, setRecordState] = useState<ConnectionStateFilter>('all');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ConnectionRecord | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [kind, setKind] = useState<'all' | 'connection' | 'request'>('all');
  const [replay, setReplay] = useState(false);
  const [replayBase, setReplayBase] = useState(() => Date.now());
  const [replayPosition, setReplayPosition] = useState(172800);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [exporting, setExporting] = useState(false);
  const at = replay ? new Date(replayBase - (172800 - replayPosition) * 1000).toISOString() : null;
  const openLog = useCallback((record?: ConnectionRecord) => { setSelected(record ?? null); setHost(''); setClaude(false); setRoute('all'); setRecordState('all'); setKind('all'); setOffset(0); setReplay(false); setPlaying(false); setOpen(true); }, []);
  useImperativeHandle(controllerRef, () => ({ open: openLog, openRoute: value => { openLog(); setRoute(value); setRecordState(value === 'blocked' ? 'all' : 'active'); setKind('connection'); } }), [openLog]);
  useEffect(() => {
    if (!playing || !replay || !open || !visible || replayPosition >= 172800) return;
    const timer = window.setInterval(() => { if (!document.hidden) setReplayPosition(value => Math.min(172800, value + speed)); }, 1000);
    return () => window.clearInterval(timer);
  }, [playing, replay, open, visible, speed, replayPosition]);
  const requestRevision = useRef(0);
  useEffect(() => {
    if (!visible || clearing) return;
    let cancelled = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending || cancelled) return;
      pending = true;
      const version = requestRevision.current;
      try {
        if (!document.hidden) {
          const next = await readConnections(open ? { host, claude, route, state: recordState, offset, limit: 50, kind, at, detailId: selected?.id } : { limit: 3 }, controller.signal);
          if (!cancelled && version === requestRevision.current) setData(next);
        }
      } catch {
        if (!cancelled && version === requestRevision.current) setData(current => current ? { ...current, available: false } : null);
      } finally {
        pending = false;
        if (!cancelled) timer = setTimeout(() => void refresh(), 4000);
      }
    };
    const onVisibility = () => { if (!document.hidden) { clearTimeout(timer); void refresh(); } };
    document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [visible, open, host, claude, route, recordState, offset, clearing, revision, kind, at, selected?.id]);
  const clear = async () => {
    requestRevision.current++;
    setClearing(true); setError('');
    try {
      const next = await clearConnections();
      setData(next); setSelected(null); setOffset(0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setClearing(false); setRevision(value => value + 1); }
  };
  const download = async (format: 'json' | 'csv') => {
    setExporting(true); setError('');
    try {
      const blob = await exportConnections({ host, claude, route, state: recordState, kind, at }, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `envguardcc-transfer-log.${format}`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  };
  const current = selected && data?.detailId === selected.id ? data.selected ?? null : selected ? data?.items.find(record => record.id === selected.id) ?? data?.recent.find(record => record.id === selected.id) ?? selected : null;
  return <>
    <TransferLogCard locale={locale} data={data} onOpen={openLog} />
    {open && visible && <TransferLogDialog locale={locale} data={data} selected={current} host={host} claude={claude} route={route} recordState={recordState} offset={offset} clearing={clearing} error={error} kind={kind} at={at} replayBase={replayBase} replayPosition={replayPosition} playing={playing && replayPosition < 172800} speed={speed} exporting={exporting}
      onKind={value => { setKind(value); setOffset(0); }} onReplay={() => { const point = Date.now(); setReplayBase(point); setReplayPosition(172740); setReplay(value => !value); setRecordState('all'); setPlaying(false); setOffset(0); setSelected(null); }} onSeek={value => { setReplayPosition(value); setPlaying(false); setOffset(0); setSelected(null); }} onPlay={() => setPlaying(value => !value)} onSpeed={setSpeed} onExport={format => void download(format)}
      onHost={value => { setHost(value); setOffset(0); }} onClaude={value => { setClaude(value); setOffset(0); }} onRoute={value => { setRoute(value); setOffset(0); setSelected(null); }} onState={value => { setRecordState(value); setOffset(0); setSelected(null); }} onPage={setOffset} onSelect={setSelected} onClear={() => void clear()} onClose={() => { setOpen(false); setPlaying(false); }} />}
  </>;
}
