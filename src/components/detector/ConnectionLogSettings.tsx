"use client";
import { useEffect, useState } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import { connectionLogSettings } from '@/detection/gateway-check';

export function ConnectionLogSettings({ locale, busy = false }: { locale: LocaleCode; busy?: boolean }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const [scope, setScope] = useState<'all' | 'claude' | ''>('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void connectionLogSettings().then(value => { if (!cancelled) setScope(value.scope); }).catch(() => { if (!cancelled) setError(zh ? '无法读取记录范围。' : 'Could not read recording scope.'); });
    return () => { cancelled = true; };
  }, [zh]); // 仅在设置页打开或语言变化时读取。
  const save = async (value: 'all' | 'claude') => {
    setWorking(true); setError('');
    try { const result = await connectionLogSettings(value); setScope(result.scope); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };
  return <section className="workspace-settings-group" aria-label={text('传输记录', 'Transfer log')}>
    <h3>{text('传输记录', 'Transfer log')}</h3>
    <p className="netcore-detail"><strong>{text('数据只存放在本机，不会上传', 'Data is stored only on this device and is never uploaded')}</strong></p>
    <label className="transfer-log-setting">{text('记录范围', 'Recording scope')}<select value={scope} disabled={busy || working || !scope} onChange={event => void save(event.target.value as 'all' | 'claude')}>
      {!scope && <option value="">{text('读取中…', 'Loading…')}</option>}<option value="all">{text('全部', 'All')}</option><option value="claude">{text('仅 Claude', 'Claude only')}</option>
    </select></label>
    <p className="netcore-detail">{text('选择“仅 Claude”会移除其他历史记录，并停止记录其他连接。请求详情只覆盖应用 HTTP 网关，不解密其他 HTTPS。', 'Choosing “Claude only” removes other history and stops recording other connections. Request details cover the app HTTP gateway; other HTTPS is not decrypted.')}</p>
    {error && <p className="netcore-alert" role="alert">{error}</p>}
  </section>;
}
