"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { helperRequest, helperUrl } from '@/detection/local-helper';
import type { LocaleCode } from '@/i18n/messages';

type DesktopStatus = {
  version: 1; state: 'idle' | 'starting' | 'running' | 'exited' | 'failed'; error: string | null;
  gateway: { requests: number; tunnels: number; failed: number; mode: 'direct' | 'proxy'; lastConnection: { host: string; state: string; error: string | null } | null } | null;
};
async function desktopRequest(token?: string): Promise<DesktopStatus> {
  const response = await fetch(`${helperUrl}/claude-desktop`, {
    method: token ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(token ? 20000 : 3500),
    headers: { 'X-CheckCC-Client': 'repair-ui', ...(token ? { 'Content-Type': 'application/json', 'X-CheckCC-Token': token } : {}) },
    body: token ? JSON.stringify({ action: 'launch' }) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  if (value.version !== 1 || !['idle', 'starting', 'running', 'exited', 'failed'].includes(value.state)) throw new Error('本机助手版本不支持启动 Claude，请重启 EnvGuardCC。 / Restart EnvGuardCC to update the local service.');
  return value;
}

export function ClaudeDesktopLaunch({ locale, connected, protectionEnabled }: { locale: LocaleCode; connected: boolean; protectionEnabled: boolean }) {
  const text = (cn: string, en: string) => locale.startsWith('zh') ? cn : en;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const pending = useRef(false);
  const reading = useRef(false);
  const epoch = useRef(0);
  const alive = useRef(false);
  const invalidate = useCallback(() => { epoch.current++; }, []);
  const refresh = useCallback(async () => {
    if (pending.current || reading.current) return;
    reading.current = true;
    const version = epoch.current;
    try {
      const next = await desktopRequest();
      if (alive.current && version === epoch.current) { setStatus(next); setReadError(''); if (next.state === 'running') setError(''); }
    } catch (failure) { if (alive.current && version === epoch.current) { setStatus(null); setReadError(failure instanceof Error ? failure.message : String(failure)); } }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!connected) return () => { alive.current = false; invalidate(); };
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 2500);
    return () => { alive.current = false; invalidate(); clearTimeout(first); clearInterval(timer); };
  }, [connected, refresh, invalidate]);
  const launch = async () => {
    if (pending.current || !connected || !protectionEnabled) return;
    const version = ++epoch.current;
    pending.current = true; setLaunching(true); setError('');
    try {
      const session = await helperRequest('/session');
      const next = await desktopRequest(session.token);
      if (alive.current && version === epoch.current) setStatus(next);
    } catch (failure) { if (alive.current && version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; if (alive.current) setLaunching(false); }
  };
  const running = connected && status?.state === 'running';
  const starting = launching || (connected && status?.state === 'starting');
  const count = (status?.gateway?.requests ?? 0) + (status?.gateway?.tunnels ?? 0);
  const last = status?.gateway?.lastConnection;
  const detail = !connected ? text('请先连接本机服务。', 'Connect the local service first.')
    : !protectionEnabled ? text('请先开启保护。', 'Enable protection first.')
    : starting ? text('正在启动 Claude 桌面客户端…', 'Starting Claude desktop…')
    : running ? count ? text(`客户端运行中，EnvGuardCC 已转发 ${count} 条连接。`, `Client running. EnvGuardCC forwarded ${count} connections.`) : text('客户端进程已启动，尚未收到网关连接。', 'Client process started. No gateway connection received yet.')
    : status?.state === 'exited' ? text('启动进程已退出，可重新启动。', 'The launch process exited. You can start again.')
    : text('点击打开 Claude 桌面客户端。', 'Open the Claude desktop client.');
  const failure = error || readError || status?.error || (running && last?.state === 'failed' ? text('最近一次连接失败：', 'Last connection failed: ') + last.error : '');
  const title = [detail, failure, text('通过 EnvGuardCC 代理启动，使用独立配置，首次可能需要登录。退出 EnvGuardCC 后代理连接关闭。', 'Starts through the EnvGuardCC proxy with a separate profile; initial sign-in may be needed. Quitting EnvGuardCC closes the proxy.')].filter(Boolean).join('\n');
  return <>
    <button type="button" className="repair-button repair-button--quiet" disabled={!connected || !protectionEnabled || starting || running} aria-busy={starting} aria-describedby="claude-launch-status" title={title} onClick={() => void launch()}>{starting ? text('启动中…', 'Starting…') : running ? text('Claude已启动', 'Claude started') : text('Claude启动', 'Launch Claude')}</button>
    <span id="claude-launch-status" className="sr-only" role="status">{detail}</span>
    {failure && connected && <span className="workspace-state min-w-0 wrap-anywhere" role="alert">{failure}</span>}
  </>;
}
