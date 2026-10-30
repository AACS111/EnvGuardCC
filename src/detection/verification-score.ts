import { detectionConfig } from './config';
import { signalPolicy } from './signal-policy';
import type { SignalResult } from './types';

// Reference: https://github.com/AACS111/EnvGuardCC/blob/main/src/detection/config/signals.ts
// Reference risk weights become full credit for a measured pass, provisional half credit while unresolved.
// Extended checks keep a positive configured weight, or a baseline of one point.
export const verificationWeights: Readonly<Record<string, number>> = {
  timezone: 26, language: 20, languageVariant: 12, chineseFonts: 16,
  vendorFonts: 10, domesticBrowser: 8, domesticDevice: 6, locale: 6,
  timezoneOffset: 4, emojiStyle: 4, country: 20,
};
export function verificationWeight(id: string) {
  const config = detectionConfig.signals[id];
  if (!config?.enabled) return 0;
  return verificationWeights[id] ?? (config.weight > 0 ? config.weight : 1);
}

export function verificationSampleStatus(sample?: SignalResult & { state?: string }) {
  if (sample?.assessment === 'not_applicable') return 'not_applicable';
  if (sample?.assessment === 'error' && sample.state !== 'running') return 'failed';
  if (!sample?.testedAt || !Number.isFinite(Date.parse(sample.testedAt)) || !sample.value || sample.state === 'pending' || sample.state === 'running' || sample.observation || sample.assessment === 'unknown' || !sample.assessment || !Number.isFinite(sample.contribution)) return 'pending';
  return sample.assessment === 'ok' && sample.contribution === 0 ? 'passed' : 'failed';
}
export function verificationPassed(sample?: SignalResult) { return verificationSampleStatus(sample) === 'passed'; }
export function verificationPoint(sample?: SignalResult, id = sample?.id): number | null {
  const status = verificationSampleStatus(sample);
  const weight = id ? verificationWeight(id) : 0;
  return status === 'passed' ? weight : status === 'failed' ? 0 : status === 'pending' && id ? weight / 2 : null;
}
export function verificationLabel(sample: (SignalResult & { state?: string }) | undefined, zh: boolean, id = sample?.id) {
  const status = verificationSampleStatus(sample);
  if (status === 'passed') {
    const points = verificationWeight(sample!.id);
    return points > 0 ? (zh ? '通过 +' + points : 'Passed +' + points) : (zh ? '通过 · 不计分' : 'Passed · informational');
  }
  if (status === 'failed') return sample?.assessment === 'error' ? (zh ? '检测失败 · 0分' : 'Failed · 0 pts') : (zh ? '未通过 · 0分' : 'Not passed · 0 pts');
  if (status === 'not_applicable') return zh ? '不适用' : 'N/A';
  if (sample?.assessment === 'error') return zh ? '测试失败' : 'Failed';
  const provisional = id ? verificationWeight(id) / 2 : 0;
  const label = sample?.observation === 'unavailable' ? (zh ? '已测·无数据' : 'Tested · no data') : sample?.observation === 'inconclusive' || sample?.observation === 'review' ? (zh ? '无法判定' : 'Inconclusive') : (zh ? '未测试' : 'Untested');
  if (provisional > 0) return label + (zh ? ' · 暂计 +' : ' · provisional +') + provisional;
  if (sample?.observation === 'unavailable') return zh ? '已测·无数据' : 'Tested · no data';
  if (sample?.observation === 'inconclusive' || sample?.observation === 'review') return zh ? '无法判定' : 'Inconclusive';
  if (sample?.state === 'running') return zh ? '测试中' : 'Testing';
  return zh ? '未判定' : 'Unresolved';
}
export function verificationItem(id: string, browser?: SignalResult, claude?: SignalResult) {
  const { scope } = signalPolicy(id);
  const samples = scope === 'browser' ? [browser] : scope === 'claude' ? [claude] : [browser, claude];
  if (samples.every(sample => sample?.assessment === 'not_applicable')) return 'not_applicable';
  const states = samples.filter(sample => sample?.assessment !== 'not_applicable').map(verificationSampleStatus);
  if (states.some(status => status === 'failed')) return 'failed';
  if (states.some(status => status === 'pending')) return 'pending';
  return 'passed';
}
export function verificationScores(browser: SignalResult[] | null, claude: SignalResult[] | null) {
  const entries = Object.entries(detectionConfig.signals).filter(([, config]) => config.enabled);
  const summarize = (side: 'browser' | 'claude' | 'combined') => {
    let passed = 0, possible = 0, pending = 0, failed = 0, earned = 0, maximum = 0, provisional = 0;
    for (const [id] of entries) {
      const { scope } = signalPolicy(id);
      if (side !== 'combined' && scope !== 'both' && scope !== side) continue;
      const left = browser?.find(sample => sample.id === id), right = claude?.find(sample => sample.id === id);
      const samples = [
        ...(side !== 'claude' && scope !== 'claude' ? [left] : []),
        ...(side !== 'browser' && scope !== 'browser' ? [right] : []),
      ];
      if (samples.every(sample => sample?.assessment === 'not_applicable')) continue;
      possible++;
      const weight = verificationWeight(id);
      maximum += weight;
      const states = samples.filter(sample => sample?.assessment !== 'not_applicable').map(verificationSampleStatus);
      if (states.every(status => status === 'passed')) { passed++; earned += weight; }
      else if (states.some(status => status === 'failed')) failed++;
      else { pending++; provisional += weight / 2; }
    }
    return { score: maximum > 0 ? earned + provisional : null, passed, possible, pending, failed, maximum, provisional };
  };
  const coverage = { browser: summarize('browser'), claude: summarize('claude'), combined: summarize('combined') };
  return { browser: coverage.browser.score, claude: coverage.claude.score, combined: coverage.combined.score, coverage };
}

// Weighted verification-score deficit, not a calibrated account-ban probability.
export function environmentRiskEstimates(browser: SignalResult[], claude: SignalResult[]) {
  const { coverage } = verificationScores(browser, claude);
  const summarize = (samples: SignalResult[], side: 'browser' | 'claude') => {
    let observedWeight = 0;
    const { score, maximum: totalWeight } = coverage[side];
    for (const [id, config] of Object.entries(detectionConfig.signals)) {
      const weight = verificationWeight(id);
      if (!config.enabled || weight === 0 || config.environment === (side === 'browser' ? 'claude' : 'browser')) continue;
      const sample = samples.find(item => item.id === id);
      const state = verificationSampleStatus(sample);
      if (state === 'not_applicable' || state === 'pending') continue;
      observedWeight += weight;
    }
    const value = observedWeight > 0 && score !== null && totalWeight > 0
      ? Math.round((totalWeight - score) * 100 / totalWeight)
      : null;
    return { value, observedWeight, totalWeight };
  };
  return { browser: summarize(browser, 'browser'), claude: summarize(claude, 'claude') };
}
