import { useId, type ReactNode } from 'react';

export function ScoreMeter({ value, label, pending, summary, maximum, normalized = false }: { value: number | null; label: ReactNode; pending: string; summary?: string; maximum: number; normalized?: boolean }) {
  const labelId = useId();
  const percentage = value === null ? null : Math.max(0, Math.min(100, value * 100 / Math.max(1, maximum)));
  return <div className="workspace-meter" data-normalized={normalized || undefined} data-severity={value === null ? 'pending' : value === maximum ? 'clear' : value > 0 ? 'partial' : 'low'}>
    <div className="workspace-meter__label"><span id={labelId}>{label}</span><strong>{normalized ? percentage === null ? '—' : Math.round(percentage) : value ?? '—'}<small>{value === null ? pending : ` / ${normalized ? 100 : maximum}`}</small></strong></div>
    {value === null ? <div className="workspace-meter__track" aria-label={pending} /> : <div className="workspace-meter__track" role="meter" aria-labelledby={labelId} aria-valuemin={0} aria-valuemax={Math.max(1, maximum)} aria-valuenow={value} aria-valuetext={summary ? `${value} / ${maximum} · ${summary}` : undefined}><span aria-hidden="true" style={{ left: normalized ? 0 : `clamp(4px, ${percentage}%, calc(100% - 4px))`, width: normalized ? `${percentage}%` : undefined }} /></div>}
    {summary && <p className="workspace-meter-summary">{summary}</p>}
    {normalized && value !== null && <p className="workspace-meter-summary">{value} / {maximum}</p>}
  </div>;
}
