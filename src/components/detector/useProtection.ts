"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { protectionRequest, type ProtectionReport } from '@/detection/protection';
import { watchProtectionConnection } from '@/detection/protection-connection.mjs';

export function useProtection() {
  const [report, setReport] = useState<ProtectionReport | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const pending = useRef(false);
  const mutating = useRef(false);
  const version = useRef(0);
  const wasConnected = useRef(false);
  const recovery = useRef({ needed: false, retryAt: 0, delay: 3000 });
  const refresh = useCallback(async () => {
    if (pending.current || mutating.current) return;
    pending.current = true;
    const current = version.current;
    let statusRead = false;
    try {
      let next = await protectionRequest();
      statusRead = true;
      if (!alive.current || mutating.current || current !== version.current) return;
      if (!wasConnected.current) recovery.current.needed = true;
      wasConnected.current = true; setConnected(true); setReport(next);
      const wanted = next.desiredEnabled ?? next.enabled;
      if (!wanted) { recovery.current = { needed: false, retryAt: 0, delay: 3000 }; setError(''); return; }
      if (next.phase === 'idle' || next.phase === 'restart_required' || next.testState === 'failed') recovery.current.needed = true;
      if (!recovery.current.needed || Date.now() < recovery.current.retryAt || next.testing || ['starting', 'stopping', 'restore_failed'].includes(next.phase)) return;
      mutating.current = true; setBusy(true);
      try {
        next = await protectionRequest('resume');
        if (!alive.current) return;
        setReport(next);
        if (next.testState !== 'passed' && (next.desiredEnabled ?? next.enabled)) throw new Error(next.testError || '自动重连检测尚未完成');
        recovery.current = { needed: false, retryAt: 0, delay: 3000 };
        setError('');
      } finally { mutating.current = false; if (alive.current) setBusy(false); }
    } catch (failure) {
      if (current !== version.current) return;
      recovery.current.needed = true;
      recovery.current.retryAt = Date.now() + recovery.current.delay;
      recovery.current.delay = Math.min(recovery.current.delay * 2, 30000);
      if (alive.current) {
        if (!statusRead || failure instanceof TypeError || failure instanceof DOMException) { wasConnected.current = false; setConnected(false); }
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
    finally { pending.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 2500);
    const unwatch = watchProtectionConnection(() => {
      recovery.current.needed = true; recovery.current.retryAt = 0;
      void refresh();
    });
    return () => { alive.current = false; clearTimeout(first); clearInterval(timer); unwatch(); };
  }, [refresh]);
  const act = async (action: string, data: object = {}) => {
    if (mutating.current) throw new Error('已有配置操作正在执行，请稍后重试。');
    version.current++;
    mutating.current = true; setBusy(true); setError('');
    if (action === 'stop') recovery.current = { needed: false, retryAt: 0, delay: 3000 };
    try {
      const next = await protectionRequest(action, data);
      if (alive.current) { setReport(next); setConnected(true); wasConnected.current = true; }
      return next;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); throw failure; }
    finally { mutating.current = false; if (alive.current) setBusy(false); void refresh(); }
  };
  return { report, connected, error, busy, refresh, act };
}
