import { signalPolicy } from './signal-policy';
import type { SignalResult } from './types';

export function measurementContribution(sample?: SignalResult) {
  return sample?.assessment !== 'not_applicable' && Number.isFinite(sample?.contribution) ? Math.max(0, sample!.contribution) : 0;
}

export function measurementAbnormal(sample?: SignalResult) {
  return Boolean(sample && sample.assessment !== 'not_applicable' && (measurementContribution(sample) > 0 || sample.assessment === 'error'));
}

export function measurementPoints(id: string, browser?: SignalResult, claude?: SignalResult) {
  const scope = signalPolicy(id).scope;
  const samples = scope === 'browser' ? [browser] : scope === 'claude' ? [claude] : [browser, claude];
  return Math.max(0, ...samples.map(measurementContribution));
}

export function measurementStatus(id: string, browser?: SignalResult, claude?: SignalResult) {
  const scope = signalPolicy(id).scope;
  const samples = scope === 'browser' ? [browser] : scope === 'claude' ? [claude] : [browser, claude];
  if (samples.every(sample => sample?.assessment === 'not_applicable')) return 'not_applicable';
  const applicable = samples.filter(sample => sample?.assessment !== 'not_applicable');
  if (applicable.some(sample => sample?.assessment === 'error')) return 'error';
  if (applicable.some(sample => !sample?.testedAt || !sample.value || sample.assessment === 'unknown')) return 'pending';
  return 'measured';
}
