import { useId, type ReactNode } from 'react';

export function ScoreMeter({ value, label, pending, summary, maximum }: { value: number | null; label: ReactNode; pending: string; summary?: string; maximum: number }) {
  const labelId = useId();
  return <div className="workspace-meter" data-severity={value === null ? 'pending' : value === maximum ? 'clear' : value > 0 ? 'partial' : 'low'}>
    <div className="workspace-meter__label"><span id={labelId}>{label}</span><strong>{value ?? '—'}<small>{value === null ? pending : ` / ${maximum}`}</small></strong></div>
    {value === null ? <div className="workspace-meter__track" aria-label={pending} /> : <div className="workspace-meter__track" role="meter" aria-labelledby={labelId} aria-valuemin={0} aria-valuemax={Math.max(1, maximum)} aria-valuenow={value} aria-valuetext={summary ? `${value} / ${maximum} · ${summary}` : undefined}><span aria-hidden="true" style={{ left: `clamp(4px, ${Math.max(0, Math.min(100, value * 100 / Math.max(1, maximum)))}%, calc(100% - 4px))` }} /></div>}
    {summary && <p className="workspace-meter-summary">{summary}</p>}
  </div>;
}
