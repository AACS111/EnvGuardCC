"use client";

import type { SignalView } from '@/detection/client-engine';
import type { LocaleCode } from '@/i18n/messages';
import { signalPolicy } from '@/detection/signal-policy';
import { verificationLabel, verificationSampleStatus } from '@/detection/verification-score';
import { requirementLabel, signalRequirement } from '@/detection/signal-requirement';

export function SignalTable({ signals, browser, claude, locale, onSelect }: { signals: SignalView[]; browser: SignalView[]; claude: SignalView[]; locale: LocaleCode; onSelect: (id: string) => void }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const cell = (id: string, sample: SignalView | undefined, applicable: boolean) => {
    const status = applicable ? verificationSampleStatus(sample) : 'not_applicable';
    return <td><span className="workspace-sample-value">{status === 'not_applicable' ? '—' : sample?.value || text('未采样', 'Not sampled')}</span><span className="workspace-result" data-result={status} title={applicable ? verificationLabel(sample, zh, id) : undefined}>{status === 'not_applicable' ? text('不适用', 'N/A') : status === 'passed' ? sample?.cloaked ? text('保护后通过', 'Protected pass') : text('原生通过', 'Native pass') : verificationLabel(sample, zh, id)}</span></td>;
  };
  return <div className="workspace-results-table workspace-panel">
    <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={text('检测结果', 'Test results')}>
      <table className="workspace-test-table"><colgroup><col style={{ width: '23%' }} /><col style={{ width: '28%' }} /><col style={{ width: '28%' }} /><col style={{ width: '21%' }} /></colgroup>
        <thead><tr>{[text('检测项目', 'Test item'), text('浏览器', 'Browser'), text('客户端', 'Client'), text('处理范围', 'Scope')].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{signals.map(signal => { const scope = signalPolicy(signal.id).scope; return <tr key={signal.id}>
          <th scope="row"><button type="button" className="workspace-text-link" onClick={() => onSelect(signal.id)} aria-haspopup="dialog">{signal.label}</button></th>
          {cell(signal.id, browser.find(item => item.id === signal.id), scope !== 'claude')}
          {cell(signal.id, claude.find(item => item.id === signal.id), scope !== 'browser')}
          <td>{requirementLabel(zh, signalRequirement(signal.id))}</td>
        </tr>; })}</tbody>
      </table>
      {!signals.length && <p className="workspace-empty">{text('没有匹配的检测项目。', 'No matching test items.')}</p>}
    </div>
    <div className="workspace-table-footer"><span>{text(`显示 ${signals.length} 项`, `Showing ${signals.length} items`)}</span><span>{text('点击项目查看判定依据与配置', 'Select an item for evidence and configuration')}</span></div>
  </div>;
}
